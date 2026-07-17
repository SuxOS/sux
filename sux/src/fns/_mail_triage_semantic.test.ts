import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./_mail_triage_log", () => ({ readTriageEntries: vi.fn() }));

import { readTriageEntries } from "./_mail_triage_log";
import { classifyByHistory, triageSemanticIndex } from "./_mail_triage_semantic";
import type { TriageEntry } from "./_mail_triage_log";

const entries = readTriageEntries as unknown as ReturnType<typeof vi.fn>;

function kvStub() {
	const store = new Map<string, string>();
	return { store, get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)) };
}

// A tiny deterministic "embedding": orthogonal 3-dim vectors per keyword bucket, so cosine
// similarity is exactly 1 for a same-bucket match and 0 for a different bucket — good enough
// to exercise voting/thresholding without a real model.
function vecFor(text: string): number[] {
	if (/receipt/i.test(text)) return [1, 0, 0];
	if (/meeting/i.test(text)) return [0, 1, 0];
	return [0, 0, 1];
}
const aiEnv = () => ({ OAUTH_KV: kvStub(), AI: { run: vi.fn(async (_m: string, inputs: any) => ({ data: (inputs.text as string[]).map(vecFor) })) } }) as any;

function mkEntry(id: string, subject: string, label: string, action: TriageEntry["action"] = "acted"): TriageEntry {
	return { cycle: "c1", id, action, label, confidence: 0.8, reason: "test", subject, at: 0 };
}

afterEach(() => vi.clearAllMocks());

describe("triageSemanticIndex", () => {
	it("returns null when AI isn't configured", async () => {
		entries.mockResolvedValue([mkEntry("1", "Receipt for order #1", "receipt")]);
		expect(await triageSemanticIndex({} as any)).toBeNull();
	});

	it("returns null when there's no trainable history (cold start)", async () => {
		entries.mockResolvedValue([]);
		expect(await triageSemanticIndex(aiEnv())).toBeNull();
	});

	it("excludes suggested-only entries, unknown-label entries, and entries with no subject", async () => {
		entries.mockResolvedValue([
			mkEntry("1", "Receipt for order #1", "receipt", "suggested"),
			mkEntry("2", "Some subject", "unknown"),
			{ ...mkEntry("3", "x", "receipt"), subject: undefined },
		]);
		expect(await triageSemanticIndex(aiEnv())).toBeNull();
	});

	it("embeds each trainable entry and persists the index for reuse", async () => {
		entries.mockResolvedValue([mkEntry("1", "Receipt for order #1", "receipt"), mkEntry("2", "Team meeting notes", "personal")]);
		const env = aiEnv();
		const idx = await triageSemanticIndex(env);
		expect(idx).toHaveLength(2);
		expect(env.AI.run).toHaveBeenCalledTimes(1); // one batched embed call for both entries
		expect(await env.OAUTH_KV.get("sux:mail_triage:semantic")).toBeTruthy();
	});

	it("on a later call, re-embeds only entries whose label changed and drops entries no longer in the log", async () => {
		const env = aiEnv();
		entries.mockResolvedValue([mkEntry("1", "Receipt for order #1", "receipt"), mkEntry("2", "Team meeting notes", "personal")]);
		await triageSemanticIndex(env);
		env.AI.run.mockClear();

		// "1" re-filed to a different label (re-embed needed); "2" dropped from the log entirely
		// (aged out of the capped log); "3" is new.
		entries.mockResolvedValue([mkEntry("1", "Receipt for order #1", "transaction"), mkEntry("3", "New receipt", "receipt")]);
		const idx = await triageSemanticIndex(env);
		expect(env.AI.run).toHaveBeenCalledTimes(1);
		const texts = (env.AI.run.mock.calls[0][1].text as string[]).slice().sort();
		expect(texts).toEqual(["New receipt", "Receipt for order #1"]);
		expect(idx?.map((e) => e.id).sort()).toEqual(["1", "3"]);
	});
});

describe("classifyByHistory", () => {
	it("returns null with no subject on the query message", async () => {
		entries.mockResolvedValue([mkEntry("1", "Receipt for order #1", "receipt")]);
		expect(await classifyByHistory(aiEnv(), { id: "q" })).toBeNull();
	});

	it("returns null when history is too small to trust a vote (< MIN_VOTES)", async () => {
		entries.mockResolvedValue([mkEntry("1", "Receipt for order #1", "receipt"), mkEntry("2", "Another receipt", "receipt")]);
		expect(await classifyByHistory(aiEnv(), { id: "q", subject: "Receipt for order #99" })).toBeNull();
	});

	it("votes the majority label among the K nearest same-bucket past filings", async () => {
		entries.mockResolvedValue([
			mkEntry("1", "Receipt for order #1", "receipt"),
			mkEntry("2", "Receipt for order #2", "receipt"),
			mkEntry("3", "Receipt for order #3", "receipt"),
			mkEntry("4", "Team meeting notes", "personal"),
		]);
		const c = await classifyByHistory(aiEnv(), { id: "q", subject: "Receipt for order #99" });
		expect(c?.label).toBe("receipt");
		expect(c?.confidence).toBeGreaterThan(0);
		expect(c?.confidence).toBeLessThanOrEqual(0.75);
		expect(c?.reason).toContain("similar past filings");
	});

	it("returns null when no neighbor clears the cosine floor (a genuinely novel subject)", async () => {
		entries.mockResolvedValue([
			mkEntry("1", "Receipt for order #1", "receipt"),
			mkEntry("2", "Receipt for order #2", "receipt"),
			mkEntry("3", "Receipt for order #3", "receipt"),
		]);
		// The query embeds to the "meeting" bucket ([0,1,0]) — orthogonal to every stored
		// "receipt" entry ([1,0,0]), so cosine similarity is 0 for all of them.
		const c = await classifyByHistory(aiEnv(), { id: "q", subject: "Team meeting notes" });
		expect(c).toBeNull();
	});

	it("is best-effort: an embed/AI failure falls back to null rather than throwing", async () => {
		entries.mockResolvedValue([mkEntry("1", "Receipt for order #1", "receipt"), mkEntry("2", "Receipt for order #2", "receipt"), mkEntry("3", "Receipt for order #3", "receipt")]);
		const env = aiEnv();
		env.AI.run.mockRejectedValue(new Error("boom"));
		await expect(classifyByHistory(env, { id: "q", subject: "Receipt for order #99" })).resolves.toBeNull();
	});
});
