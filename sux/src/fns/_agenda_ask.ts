// The agenda loop's "ask-me-by-email" spoke (#1243, split from #1203 W1 "d") — batches
// sux's own open questions into ONE digest mail to Colin, and reads the answer back out
// of either a reply (`answer <id> <text>`) or a star on the digest itself. Mirrors
// _agenda_reply.ts's auth-gate shape (trusted identity + digest-subject prefix + a
// ledgered Message-ID thread bind), but against its OWN sent digest — a separate ledger
// namespace, so a reply to the main agenda digest can never be mistaken for an answer
// here, or vice versa.
//
// "Open question" has no existing producer anywhere in this repo — this issue only
// builds the batch/answer machinery itself (kind (d) of #1203's four-way split; (a)/(b)/
// (c) all landed elsewhere, see #1243's own body). askAgendaQuestion is the queue any
// future detector can push a question into; nothing calls it yet, so the loop is a
// harmless no-op (composes/sends nothing) until something does.
//
// SAFETY (fail-closed, mirrors AGENDA_REPLY_ENABLED): AGENDA_ASK_ENABLED unset (or
// AGENDA_ENABLED unset) ⇒ total no-op — nothing is queued, sent, or parsed. Armed, the
// only send is ONE self-addressed digest mail (never a third party, same as
// _agenda.ts's sendDigest), and the only "answers" ever recorded are text pulled out of a
// reply that passed all three auth gates, or a star on that exact sent digest — nothing
// here acts on an answer beyond storing it for whatever asked the question to read back.
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { cappedKvLog } from "./_capped_kv_log";
import { extractEmail, looksLikeDigestReply } from "./_agenda_reply";
import type { MailRef } from "./_agenda";
import { errMsg } from "./_util";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The ask-me-by-email loop may run at all. Unset → dormant (no-op). Requires
 *  AGENDA_ENABLED too (mirrors AGENDA_REPLY_ENABLED's two-stage gate) — asking a question
 *  presupposes the agenda loop itself is armed. */
export const hasAgendaAsk = (env: RtEnv): boolean => flagOn(env.AGENDA_ASK_ENABLED) && flagOn(env.AGENDA_ENABLED);

export type AgendaQuestion = {
	id: string;
	question: string;
	context?: string;
	askedAt: string;
	/** Set the first time this question rides an outbound digest — prevents resending an
	 *  already-batched question every tick; a NEW question queued after that digest went out
	 *  still has no sentAt and rides the next one. */
	sentAt?: string;
	answeredAt?: string;
	answer?: string;
	via?: "reply" | "star";
};

const QUESTIONS_KEY = "sux:agenda_ask:questions";
const questionLog = (env: RtEnv) => cappedKvLog<AgendaQuestion>(env, QUESTIONS_KEY, 200);

/** Queue an open question for the next ask-digest — the loop's ONLY producer surface.
 *  Dedupes on exact question text among currently-unanswered entries (a re-firing
 *  detector shouldn't pile up duplicates); returns the new or existing short id. */
export async function askAgendaQuestion(env: RtEnv, question: string, context?: string): Promise<string> {
	const q = String(question ?? "").trim();
	const items = await questionLog(env).load();
	const dup = items.find((x) => !x.answeredAt && x.question === q);
	if (dup) return dup.id;
	const id = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
	await questionLog(env).push({ id, question: q, context, askedAt: new Date().toISOString() });
	return id;
}

/** Every open (unanswered) question, newest first — for a caller that wants to read the
 *  current queue without sending anything. */
export async function openAgendaQuestions(env: RtEnv): Promise<AgendaQuestion[]> {
	return (await questionLog(env).load()).filter((q) => !q.answeredAt);
}

/** Compose the ask-digest — the email interface, one line per open question with a short
 *  id Colin can answer against. Mirrors composeDigest's shape/footer style. */
export function composeAskDigest(pending: AgendaQuestion[]): { subject: string; body: string } {
	const lines: string[] = [`sux has ${pending.length} open question${pending.length === 1 ? "" : "s"} for you.`, ""];
	for (const q of pending) lines.push(`- ${q.question}${q.context ? ` (${q.context})` : ""}  \`${q.id}\``);
	lines.push("");
	lines.push("—");
	lines.push("Reply `answer <id> <your answer>` (one line per answer), or just star this email to mark them all answered with no specific text.");
	lines.push(`(e.g. reply: answer ${pending[0]?.id} yes)`);
	lines.push("\n— sux");
	const subject = `sux · ${pending.length} question${pending.length === 1 ? "" : "s"} for you`;
	return { subject, body: lines.join("\n") };
}

// `answer <id> <rest of the line>` — one per line, free text after the id. Deliberately a
// different verb from _agenda_reply's approve/snooze/reject grammar so the two never collide.
const ANSWER_RE = /^\s*answer\s+([0-9a-f]{6,8})\s+(.+)$/gim;

/** Parse every `answer <id> <text>` line out of free text. Pure and total: unparseable
 *  lines are silently dropped, never thrown. */
export function parseAnswers(text: string): Array<{ id: string; text: string }> {
	const out: Array<{ id: string; text: string }> = [];
	for (const m of String(text ?? "").matchAll(ANSWER_RE)) out.push({ id: m[1].toLowerCase(), text: m[2].trim() });
	return out;
}

export type AgendaAskDeps = {
	/** Recent unread inbox messages, newest first (id/from/subject/preview). */
	mailSearch: (env: RtEnv, opts: { limit: number }) => Promise<MailRef[]>;
	/** Colin's own verified send-from addresses (mail_identities), for the sender auth gate. */
	identities: (env: RtEnv) => Promise<string[]>;
	/** This message's In-Reply-To + References Message-IDs (raw jmap Email/get). */
	threadIds: (env: RtEnv, mailId: string) => Promise<string[]>;
	/** Full plain-text body (mail_read) — the same preview-truncation fallback _agenda_reply
	 *  uses. */
	mailBody: (env: RtEnv, mailId: string) => Promise<string>;
	/** Send the ask-digest to Colin's own primary address; best-effort resolves both its
	 *  RFC5322 Message-ID (for the thread-bind auth gate) and its own JMAP mail id (so
	 *  `starred` can poll it). Either/both may be undefined if the lookup fails — never
	 *  fails the send itself. */
	sendAskDigest: (env: RtEnv, subject: string, body: string) => Promise<{ messageId?: string; mailId?: string } | void>;
	/** Is this exact sent mail (by JMAP id) starred ($flagged)? */
	starred: (env: RtEnv, mailId: string) => Promise<boolean>;
};

export type AgendaAskReport = {
	dormant?: boolean;
	sent?: number; // open questions newly included in a digest this cycle (0 if nothing new to send)
	scanned?: number;
	answered?: string[]; // question ids answered via a parsed reply this cycle
	starred?: string[]; // question ids answered via a star this cycle
	note?: string;
	error?: string;
};

const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

const LAST_DIGEST_NS = "agenda_ask_last_digest";
const DIGEST_MSGID_NS = "agenda_ask_digest_msgid";
const SEEN_NS = "agenda_ask_reply";

/** Run one ask cycle. Fail-closed: dormant no-op unless AGENDA_ASK_ENABLED (and
 *  AGENDA_ENABLED). Sends (or resends, for newly-queued questions) a batched digest of
 *  every open question, then checks the most recently sent digest for a star and scans
 *  unread inbox replies for `answer <id> <text>` lines — both gated the same three ways
 *  _agenda_reply.ts's proposal-reply parser is (verified identity, digest-thread subject,
 *  In-Reply-To/References bound to a Message-ID this loop itself ledgered). */
export async function runAgendaAsk(env: RtEnv, opts: { max_mail?: number }, deps: AgendaAskDeps): Promise<AgendaAskReport> {
	if (!hasAgendaAsk(env)) {
		return {
			dormant: true,
			note: "agenda_ask is disabled — set AGENDA_ASK_ENABLED (requires AGENDA_ENABLED) to batch sux's open questions (queued via askAgendaQuestion) into one digest mail to yourself, and parse an answer back out of a reply ('answer <id> <text>') or a star on that digest. Fail-closed: nothing runs until the flag is set.",
		};
	}

	const log = questionLog(env);
	let items = await log.load();
	let sent = 0;

	const unsent = items.filter((x) => !x.answeredAt && !x.sentAt);
	if (unsent.length) {
		const pendingUnanswered = items.filter((x) => !x.answeredAt);
		const digest = composeAskDigest(pendingUnanswered);
		try {
			const res = await deps.sendAskDigest(env, digest.subject, digest.body);
			if (res?.messageId) await ledger(env, DIGEST_MSGID_NS).mark(res.messageId);
			const nowIso = new Date().toISOString();
			items = await log.update((cur) => cur.map((x) => (!x.answeredAt && !x.sentAt ? { ...x, sentAt: nowIso } : x)));
			sent = unsent.length;
			if (res?.mailId) await ledger(env, LAST_DIGEST_NS).mark("ptr", JSON.stringify({ mailId: res.mailId, ids: pendingUnanswered.map((x) => x.id) }));
		} catch (e) {
			return { error: `ask-digest send failed: ${errMsg(e)}` };
		}
	}

	const starredIds: string[] = [];
	try {
		const ptrRaw = await ledger(env, LAST_DIGEST_NS).get("ptr");
		if (ptrRaw) {
			const ptr = JSON.parse(ptrRaw) as { mailId: string; ids: string[] };
			if (ptr?.mailId && (await deps.starred(env, ptr.mailId))) {
				const nowIso = new Date().toISOString();
				items = await log.update((cur) => cur.map((x) => (ptr.ids.includes(x.id) && !x.answeredAt ? { ...x, answeredAt: nowIso, answer: "(marked answered via star, no text)", via: "star" as const } : x)));
				starredIds.push(...ptr.ids.filter((id) => items.find((x) => x.id === id)?.via === "star"));
			}
		}
	} catch {
		// star check is best-effort — a lookup failure just leaves those questions open
	}

	let messages: MailRef[];
	try {
		messages = await deps.mailSearch(env, { limit: numClamp(opts.max_mail, 1, 50, 25) });
	} catch (e) {
		return { sent, starred: starredIds, error: `mail scan failed: ${errMsg(e)}` };
	}
	const identities = new Set((await deps.identities(env).catch(() => [])).map((e) => e.toLowerCase()).filter(Boolean));
	const led = ledger(env, SEEN_NS);
	const digestMsgIds = ledger(env, DIGEST_MSGID_NS);
	let scanned = 0;
	const answered: string[] = [];

	for (const m of messages) {
		scanned++;
		if (await led.seen(m.id)) continue;
		if (!identities.has(extractEmail(m.from))) {
			await led.mark(m.id);
			continue;
		}
		if (!looksLikeDigestReply(m.subject)) {
			await led.mark(m.id);
			continue;
		}
		const refs = await deps.threadIds(env, m.id).catch(() => []);
		let threadMatched = false;
		for (const ref of refs) {
			if (await digestMsgIds.seen(ref)) {
				threadMatched = true;
				break;
			}
		}
		if (!threadMatched) {
			await led.mark(m.id);
			continue;
		}

		let answers = parseAnswers(m.preview ?? "");
		if (!answers.length) {
			const body = await deps.mailBody(env, m.id).catch(() => "");
			if (body) answers = parseAnswers(body);
		}
		if (answers.length) {
			const nowIso = new Date().toISOString();
			items = await log.update((cur) =>
				cur.map((x) => {
					const a = answers.find((a) => a.id === x.id);
					return a && !x.answeredAt ? { ...x, answeredAt: nowIso, answer: a.text, via: "reply" as const } : x;
				}),
			);
			answered.push(...answers.filter((a) => items.find((x) => x.id === a.id)?.via === "reply").map((a) => a.id));
		}
		await led.mark(m.id);
	}

	return { sent, scanned, answered, starred: starredIds };
}

// ── Real deps ───────────────────────────────────────────────────────────────────────
/** Production surface: mail_search (unread inbox) + mail_identities, plus jmap for
 *  thread-id resolution, sent-digest lookup, and the star ($flagged keyword) poll.
 *  Dynamically imported so the cron path pulls in the mail surface only when armed
 *  (mirrors _agenda_reply's defaultDeps). */
export async function defaultDeps(): Promise<AgendaAskDeps> {
	const mail = await import("../mail-mcp");
	const tool = (name: string) => mail.MAIL_TOOLS.find((t) => t.name === name);
	return {
		mailSearch: async (env, o) => {
			const t = tool("mail_search");
			if (!t) throw new Error("mail_search tool not found");
			const r = await t.run(env, { mailbox: "inbox", unread: true, limit: o.limit });
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "mail_search failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return (parsed.emails ?? []).map((e: any) => ({ id: String(e?.id ?? ""), from: e?.from, subject: e?.subject, preview: e?.preview, date: e?.receivedAt }));
		},
		identities: async (env) => {
			const t = tool("mail_identities");
			if (!t) throw new Error("mail_identities tool not found");
			const r = await t.run(env, {});
			if (r.isError) throw new Error(r.content?.[0]?.text ?? "mail_identities failed");
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return ((parsed.identities ?? []) as Array<{ email?: string }>).map((i) => i.email).filter((e): e is string => Boolean(e));
		},
		threadIds: async (env, mailId) => {
			const t = tool("jmap");
			if (!t) return [];
			try {
				const r = await t.run(env, { method: "Email/get", args: { ids: [mailId], properties: ["inReplyTo", "references"] } });
				if (r.isError) return [];
				const mrs = JSON.parse(r.content?.[0]?.text ?? "{}").methodResponses ?? [];
				const e = mrs.find((mr: any) => mr[0] === "Email/get")?.[1]?.list?.[0];
				const inReplyTo = Array.isArray(e?.inReplyTo) ? e.inReplyTo : [];
				const references = Array.isArray(e?.references) ? e.references : [];
				return [...inReplyTo, ...references].filter((x): x is string => Boolean(x));
			} catch {
				return [];
			}
		},
		mailBody: async (env, mailId) => {
			const t = tool("mail_read");
			if (!t) return "";
			const r = await t.run(env, { id: mailId });
			if (r.isError) return "";
			const parsed = JSON.parse(r.content?.[0]?.text ?? "{}");
			return String(parsed?.body ?? "");
		},
		sendAskDigest: async (env, subject, body) => {
			const idTool = tool("mail_identities");
			const sendTool = tool("mail_send");
			if (!idTool || !sendTool) throw new Error("mail tools not found");
			const ir = await idTool.run(env, {});
			if (ir.isError) throw new Error(ir.content?.[0]?.text ?? "mail_identities failed");
			const identities = (JSON.parse(ir.content?.[0]?.text ?? "{}").identities ?? []) as Array<{ email?: string }>;
			const self = identities[0]?.email;
			if (!self) throw new Error("no primary identity to send the ask-digest to");
			const sr = await sendTool.run(env, { to: [self], subject, text: body, force: true });
			if (sr.isError) throw new Error(sr.content?.[0]?.text ?? "mail_send failed");
			try {
				const searchTool = tool("mail_search");
				const jmapTool = tool("jmap");
				if (!searchTool || !jmapTool) return {};
				const found = await searchTool.run(env, { mailbox: "sent", subject, limit: 1 });
				if (found.isError) return {};
				const sentMsg = JSON.parse(found.content?.[0]?.text ?? "{}").emails?.[0];
				if (!sentMsg?.id) return {};
				const got = await jmapTool.run(env, { method: "Email/get", args: { ids: [sentMsg.id], properties: ["messageId"] } });
				if (got.isError) return { mailId: String(sentMsg.id) };
				const mrs = JSON.parse(got.content?.[0]?.text ?? "{}").methodResponses ?? [];
				const list = mrs.find((mr: any) => mr[0] === "Email/get")?.[1]?.list ?? [];
				const messageId = list[0]?.messageId?.[0];
				return { mailId: String(sentMsg.id), ...(messageId ? { messageId: String(messageId) } : {}) };
			} catch {
				return {};
			}
		},
		starred: async (env, mailId) => {
			const t = tool("jmap");
			if (!t) return false;
			try {
				const r = await t.run(env, { method: "Email/get", args: { ids: [mailId], properties: ["keywords"] } });
				if (r.isError) return false;
				const mrs = JSON.parse(r.content?.[0]?.text ?? "{}").methodResponses ?? [];
				const kws = mrs.find((mr: any) => mr[0] === "Email/get")?.[1]?.list?.[0]?.keywords ?? {};
				return Boolean(kws?.["$flagged"]);
			} catch {
				return false;
			}
		},
	};
}
