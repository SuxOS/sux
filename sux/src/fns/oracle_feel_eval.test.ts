import { afterEach, describe, expect, it, vi } from "vitest";

// v5 W10 (#1289) — the oracle-feel E2E eval, the arc's acceptance test: four cited-answer
// scenarios spanning scan, mail, vault, and toss ingress, automated and re-runnable via `npm
// test` (no manual click-through, no fixture-seeding step a human has to remember). Each
// scenario drives the REAL production code the ingress writes through:
//   (a) scan   — _document_radar.ts's own assimilate() call shape (post-OCR text, domain "scan")
//   (b) mail   — _mail_triage.ts's assimilateFlaggedMail's own assimilate() call shape (domain "mail")
//   (c) vault  — an existing vault note, via the vault semantic index oracle ask already reads
//   (d) toss   — ingest.ts's backgroundAssimilate call shape (domain "doc")
// then asks `oracle {action:"ask"}` and asserts a correctly-attributed citation per source
// (right pointer shape: scan path / JMAP id / vault path / ingest provenance).
//
// Only the vault semantic index needs mocking (its own suite covers building/caching, same
// idiom as _answer.test.ts) — scan/mail/toss ride the REAL assimilate() spine end-to-end
// against a stubbed AI/KV, which is what actually caught #1308's gap: `oracle ask` had no read
// leg for the assim:* domains the spine writes to, so a scanned document or triage-flagged
// email was indexed but never retrievable. This suite is the automated proof that the gap is
// closed (see _answer.ts's fromAssimChunks).
vi.mock("./_vault_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), vaultSemanticIndexCached: vi.fn(async () => null) }));

import { assimilate } from "./_assimilate";
import { oracle } from "./oracle";
import { vaultSemanticIndexCached } from "./_vault_semantic";

const vaultIdx = vaultSemanticIndexCached as unknown as ReturnType<typeof vi.fn>;

/** A minimal Map-backed OAUTH_KV (get/put/delete/list) matching the CF KV surface — the
 *  fake every suite touching _source.ts's chunk substrate uses (_assimilate.test.ts /
 *  _answer.test.ts). */
function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
			keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true as const,
		})),
	};
}

// Four scenarios can coexist in ONE run (the acceptance bullet: "all four cases pass in one
// automated run with correctly-attributed citations") without a real embedding model by
// steering the FAKE embedder with a distinct marker word per scenario: the distilled/chunk
// text carries the marker (baked into the canned distill response below), the probe QUESTION
// repeats it, and orthogonal one-hot vectors make every OTHER scenario's chunk cosine to ~0
// (below the 0.68 floor) for that question — proving the right source is cited and the other
// three, though present in the same corpus, are not.
const VEC: Record<string, number[]> = {
	PASSPORTMARK: [1, 0, 0, 0],
	MAILMARK: [0, 1, 0, 0],
	VAULTMARK: [0, 0, 1, 0],
	GROCERYMARK: [0, 0, 0, 1],
};
function vecFor(text: string): number[] {
	for (const [marker, vec] of Object.entries(VEC)) if (text.includes(marker)) return vec;
	return [0, 0, 0, 0];
}

/** env driving the REAL guarded llm()/embed() for both assimilate() and oracle ask: embed
 *  calls dispatch by marker-in-text (see VEC above); distill echoes the source's marker back
 *  into the canned distillate so the embedded chunk still carries it; the profile-consolidate
 *  and ask-synthesis passes are irrelevant to citation correctness and return a fixed string. */
function makeEnv() {
	const kv = makeKv();
	const run = vi.fn(async (_model: string, inputs: any) => {
		if (Array.isArray(inputs?.text)) return { data: inputs.text.map((t: string) => vecFor(t)) };
		const system: string = inputs.messages.find((m: any) => m.role === "system").content;
		const user: string = inputs.messages.find((m: any) => m.role === "user")?.content ?? "";
		if (/^Extract and condense the KEY KNOWLEDGE/.test(system)) {
			for (const marker of Object.keys(VEC)) if (user.includes(marker)) return { response: `Distilled note. ${marker}.` };
			return { response: "Distilled note. NOMARK." };
		}
		if (/^You are distilling an AUTHORITATIVE/.test(system)) return { response: "PROFILE-SUMMARY" };
		return { response: "CITED-ANSWER" };
	});
	const env: any = { AI: { run }, OAUTH_KV: kv, ASSIMILATE_ENABLED: "1", OBSIDIAN_VAULT_REPO: "me/vault" };
	return { env, kv, run };
}

const textCalls = (run: ReturnType<typeof vi.fn>) => run.mock.calls.filter(([, inputs]: any) => (inputs as any)?.messages);

afterEach(() => vi.clearAllMocks());

describe("oracle-feel E2E eval — v5 W10 (#1289): scan/mail/vault/toss → cited answers", () => {
	it("(a) scan a document → ask → cited answer naming the scan (scan path pointer)", async () => {
		const { env } = makeEnv();
		const spine = await assimilate(env, { source: "/documents/passport.jpg", text: "Passport expires 2030-01-01. PASSPORTMARK.", kind: "text", domain: "scan" });
		expect(spine.status).toBe("assimilated");

		const r = await oracle.run(env, { action: "ask", problem: "When does my PASSPORTMARK passport expire?" });
		const j = JSON.parse(r.content[0].text);
		expect(j.status).toBe("answered");
		expect(j.citations).toEqual(["/documents/passport.jpg"]);
		expect(j.domains.assim.status).toBe("ok");
	});

	it("(b) a recent triage-flagged email → ask → cited answer with a JMAP pointer", async () => {
		const { env } = makeEnv();
		const spine = await assimilate(env, { source: "mail:m-901", text: "Subject: Policy renewal\nFrom: insurer@example.com\n\nYour policy renews next month. MAILMARK.", kind: "text", domain: "mail" });
		expect(spine.status).toBe("assimilated");

		const r = await oracle.run(env, { action: "ask", problem: "When does my MAILMARK insurance policy renew?" });
		const j = JSON.parse(r.content[0].text);
		expect(j.status).toBe("answered");
		expect(j.citations).toEqual(["mail:m-901"]);
		expect(j.domains.assim.status).toBe("ok");
	});

	it("(c) an existing vault note → ask → cited answer with a vault path pointer", async () => {
		const { env } = makeEnv();
		vaultIdx.mockResolvedValueOnce({
			sha: "headsha",
			version: 1,
			at: 7777,
			total: 1,
			truncated: false,
			chunks: [{ path: "Health/Labs.md", title: "Labs", text: "Creatinine 1.1 in May. VAULTMARK.", embedding: VEC.VAULTMARK }],
		});

		const r = await oracle.run(env, { action: "ask", problem: "What was my last creatinine per VAULTMARK labs?" });
		const j = JSON.parse(r.content[0].text);
		expect(j.status).toBe("answered");
		expect(j.citations).toEqual(["vault:Health/Labs.md"]);
		expect(j.domains.vault).toMatchObject({ status: "ok", indexed_at: 7777 });
	});

	it("(d) ingest freeform text → ask → cited answer with ingest provenance (the vault note path it landed at)", async () => {
		const { env } = makeEnv();
		const notePath = "Inbox/2026-07-22 grocery-list.md";
		const spine = await assimilate(env, { source: notePath, text: "Pick up milk, eggs, and bread. GROCERYMARK.", kind: "text", domain: "doc" });
		expect(spine.status).toBe("assimilated");

		const r = await oracle.run(env, { action: "ask", problem: "What's on my GROCERYMARK list?" });
		const j = JSON.parse(r.content[0].text);
		expect(j.status).toBe("answered");
		expect(j.citations).toEqual([notePath]);
		expect(j.domains.assim.status).toBe("ok");
	});

	it("all four cases pass in ONE run, correctly attributed — no cross-contamination between sources", async () => {
		const { env, run } = makeEnv();
		vaultIdx.mockResolvedValue({
			sha: "headsha",
			version: 1,
			at: 7777,
			total: 1,
			truncated: false,
			chunks: [{ path: "Health/Labs.md", title: "Labs", text: "Creatinine 1.1 in May. VAULTMARK.", embedding: VEC.VAULTMARK }],
		});
		await assimilate(env, { source: "/documents/passport.jpg", text: "Passport expires 2030-01-01. PASSPORTMARK.", kind: "text", domain: "scan" });
		await assimilate(env, { source: "mail:m-901", text: "Your policy renews next month. MAILMARK.", kind: "text", domain: "mail" });
		const notePath = "Inbox/2026-07-22 grocery-list.md";
		await assimilate(env, { source: notePath, text: "Pick up milk, eggs, and bread. GROCERYMARK.", kind: "text", domain: "doc" });

		const cases: Array<{ label: string; question: string; expectCitation: string }> = [
			{ label: "a-scan", question: "When does my PASSPORTMARK passport expire?", expectCitation: "/documents/passport.jpg" },
			{ label: "b-mail", question: "When does my MAILMARK insurance policy renew?", expectCitation: "mail:m-901" },
			{ label: "c-vault", question: "What was my last creatinine per VAULTMARK labs?", expectCitation: "vault:Health/Labs.md" },
			{ label: "d-toss", question: "What's on my GROCERYMARK list?", expectCitation: notePath },
		];

		const failures: string[] = [];
		for (const c of cases) {
			const r = await oracle.run(env, { action: "ask", problem: c.question });
			const j = JSON.parse(r.content[0].text);
			if (j.status !== "answered") failures.push(`${c.label}: expected status "answered", got "${j.status}"`);
			else if (!j.citations.includes(c.expectCitation)) failures.push(`${c.label}: expected citation "${c.expectCitation}", got ${JSON.stringify(j.citations)}`);
			else if (j.citations.length !== 1) failures.push(`${c.label}: expected exactly one citation (no cross-contamination), got ${JSON.stringify(j.citations)}`);
		}
		expect(failures).toEqual([]);

		// The synthesis prompt for the last (toss) ask actually carried the cited passage's
		// text — proof the model COULD ground a "naming the scan"-style answer in it.
		const calls = textCalls(run);
		const last = calls[calls.length - 1];
		expect(last?.[1].messages.find((m: any) => m.role === "user").content).toContain("GROCERYMARK");
	});
});
