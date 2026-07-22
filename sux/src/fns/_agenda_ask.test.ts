import { describe, expect, it, vi } from "vitest";

import { type AgendaAskDeps, askAgendaQuestion, composeAskDigest, openAgendaQuestions, parseAnswers, runAgendaAsk } from "./_agenda_ask";
import { ledger } from "../ledger";
import type { MailRef } from "./_agenda";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = (extra: Record<string, unknown> = {}) => ({ AGENDA_ENABLED: "1", AGENDA_ASK_ENABLED: "1", VAULT_TZ: "UTC", OAUTH_KV: kvStub(), ...extra }) as any;

const SELF = "colin@example.com";
const ASK_DIGEST_MSG_ID = "ask-digest-2026-07-22@fastmail.example";
const ledgerAskDigest = (e: any, id = ASK_DIGEST_MSG_ID) => ledger(e, "agenda_ask_digest_msgid").mark(id);

const deps = (mail: MailRef[], over: Partial<AgendaAskDeps> = {}): AgendaAskDeps => ({
	mailSearch: vi.fn(async () => mail),
	identities: vi.fn(async () => [SELF]),
	threadIds: vi.fn(async () => []),
	mailBody: vi.fn(async () => ""),
	sendAskDigest: vi.fn(async () => ({ messageId: ASK_DIGEST_MSG_ID, mailId: "sent-1" })),
	starred: vi.fn(async () => false),
	...over,
});

describe("agenda_ask — command grammar", () => {
	it("parses answer <id> <text> lines", () => {
		expect(parseAnswers("answer 1a2b3c4d yes please")).toEqual([{ id: "1a2b3c4d", text: "yes please" }]);
	});

	it("parses multiple answer lines, case-insensitively", () => {
		const text = "Answer 1a2b3c4d yes\nANSWER 5e6f7a8b no thanks";
		expect(parseAnswers(text)).toEqual([
			{ id: "1a2b3c4d", text: "yes" },
			{ id: "5e6f7a8b", text: "no thanks" },
		]);
	});

	it("ignores prose with no answer tokens", () => {
		expect(parseAnswers("Thanks for asking, I'll get back to you.")).toEqual([]);
	});
});

describe("agenda_ask — composeAskDigest", () => {
	it("lists each open question with its id", () => {
		const d = composeAskDigest([{ id: "abc12345", question: "Renew the lease?", askedAt: "2026-07-22T00:00:00Z" }]);
		expect(d.subject).toContain("1 question");
		expect(d.body).toContain("Renew the lease?");
		expect(d.body).toContain("abc12345");
	});
});

describe("agenda_ask — queue", () => {
	it("askAgendaQuestion dedupes identical open questions", async () => {
		const e = env();
		const id1 = await askAgendaQuestion(e, "Renew the lease?");
		const id2 = await askAgendaQuestion(e, "Renew the lease?");
		expect(id1).toBe(id2);
		expect(await openAgendaQuestions(e)).toHaveLength(1);
	});

	it("openAgendaQuestions excludes answered questions", async () => {
		const e = env();
		await askAgendaQuestion(e, "Q1");
		await askAgendaQuestion(e, "Q2");
		expect(await openAgendaQuestions(e)).toHaveLength(2);
	});
});

describe("agenda_ask — loop", () => {
	it("is dormant unless AGENDA_ASK_ENABLED (and AGENDA_ENABLED)", async () => {
		const r1 = await runAgendaAsk({ VAULT_TZ: "UTC", OAUTH_KV: kvStub() } as any, {}, deps([]));
		expect(r1.dormant).toBe(true);
		const r2 = await runAgendaAsk(env({ AGENDA_ENABLED: "0" }), {}, deps([]));
		expect(r2.dormant).toBe(true);
	});

	it("sends a digest for newly-queued open questions, once", async () => {
		const e = env();
		await askAgendaQuestion(e, "Renew the lease?");
		const send = vi.fn(async () => ({ messageId: ASK_DIGEST_MSG_ID, mailId: "sent-1" }));
		const r1 = await runAgendaAsk(e, {}, deps([], { sendAskDigest: send }));
		expect(r1.sent).toBe(1);
		expect(send).toHaveBeenCalledTimes(1);

		const r2 = await runAgendaAsk(e, {}, deps([], { sendAskDigest: send }));
		expect(r2.sent).toBe(0);
		expect(send).toHaveBeenCalledTimes(1); // no new question queued — no resend
	});

	it("records an answer from a trusted digest-reply", async () => {
		const e = env();
		const id = await askAgendaQuestion(e, "Renew the lease?");
		await runAgendaAsk(e, {}, deps([]));
		await ledgerAskDigest(e);

		const mail: MailRef[] = [{ id: "m1", from: `"Colin" <${SELF}>`, subject: "Re: sux · 1 question for you", preview: `answer ${id} yes, go ahead` }];
		const r = await runAgendaAsk(e, {}, deps(mail, { threadIds: vi.fn(async () => [ASK_DIGEST_MSG_ID]) }));
		expect(r.answered).toEqual([id]);
		const open = await openAgendaQuestions(e);
		expect(open).toHaveLength(0);
	});

	it("ignores a reply from an untrusted sender", async () => {
		const e = env();
		const id = await askAgendaQuestion(e, "Renew the lease?");
		await runAgendaAsk(e, {}, deps([]));
		await ledgerAskDigest(e);

		const mail: MailRef[] = [{ id: "m1", from: "stranger@evil.example", subject: "Re: sux · 1 question for you", preview: `answer ${id} yes` }];
		const r = await runAgendaAsk(e, {}, deps(mail, { threadIds: vi.fn(async () => [ASK_DIGEST_MSG_ID]) }));
		expect(r.answered ?? []).toEqual([]);
		expect(await openAgendaQuestions(e)).toHaveLength(1);
	});

	it("ignores a reply whose thread isn't bound to a ledgered ask-digest", async () => {
		const e = env();
		const id = await askAgendaQuestion(e, "Renew the lease?");
		await runAgendaAsk(e, {}, deps([]));
		// deliberately never ledgers ASK_DIGEST_MSG_ID this time

		const mail: MailRef[] = [{ id: "m1", from: `"Colin" <${SELF}>`, subject: "Re: sux · 1 question for you", preview: `answer ${id} yes` }];
		const r = await runAgendaAsk(e, {}, deps(mail, { threadIds: vi.fn(async () => ["some-other-thread@example.com"]) }));
		expect(r.answered ?? []).toEqual([]);
		expect(await openAgendaQuestions(e)).toHaveLength(1);
	});

	it("marks the batched questions answered when the digest itself is starred", async () => {
		const e = env();
		await askAgendaQuestion(e, "Renew the lease?");
		await runAgendaAsk(e, {}, deps([], { sendAskDigest: vi.fn(async () => ({ messageId: ASK_DIGEST_MSG_ID, mailId: "sent-1" })) }));

		const r = await runAgendaAsk(e, {}, deps([], { starred: vi.fn(async (_env, mailId) => mailId === "sent-1") }));
		expect(r.starred).toHaveLength(1);
		expect(await openAgendaQuestions(e)).toHaveLength(0);
	});
});
