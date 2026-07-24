import { describe, expect, it } from "vitest";
import { appendFeedback, readFeedback, resolveFeedback } from "./_feedback";

// A KV whose get/put yield to the event loop, so two unserialized read-modify-writes
// of the same key would interleave and lose an update. appendFeedback serializes them.
function racyEnv() {
	const store = new Map<string, string>();
	const tick = () => new Promise<void>((r) => setTimeout(r, 0));
	return {
		store,
		OAUTH_KV: {
			get: async (k: string) => {
				await tick();
				return store.get(k) ?? null;
			},
			put: async (k: string, v: string) => {
				await tick();
				store.set(k, v);
			},
		},
	} as any;
}

describe("appendFeedback — concurrency", () => {
	it("does not lose entries when many appends race in one isolate", async () => {
		const env = racyEnv();
		await Promise.all(Array.from({ length: 8 }, (_, i) => appendFeedback(env, "issue", `note ${i}`)));
		const items = await readFeedback(env, "issue", 100);
		expect(items).toHaveLength(8);
		expect(new Set(items.map((i) => i.text)).size).toBe(8);
	});

	it("returns a strictly incrementing total across serialized racing appends", async () => {
		const env = racyEnv();
		const totals = (await Promise.all(Array.from({ length: 5 }, () => appendFeedback(env, "suggest", "x")))).map((r) => r.total).sort((a, b) => a - b);
		expect(totals).toEqual([1, 2, 3, 4, 5]);
	});
});

describe("resolveFeedback / readFeedback resolved-filtering (#1400)", () => {
	it("resolving an entry hides it from the default (unresolved-only) view but not from ?all", async () => {
		// A single entry, resolved by its own `at` — avoids any dependence on two calls
		// landing on distinct milliseconds (Date.now() is not faked here).
		const env = racyEnv();
		const { at } = await appendFeedback(env, "issue", "stale complaint");
		const resolvedCount = await resolveFeedback(env, at, { tracked_by: "https://github.com/x/y/issues/1" });
		expect(resolvedCount).toBe(1);
		expect(await readFeedback(env, "issue", 100)).toHaveLength(0);
		const all = await readFeedback(env, "issue", 100, undefined, true);
		expect(all).toHaveLength(1);
		expect(all[0].resolved?.tracked_by).toBe("https://github.com/x/y/issues/1");
	});

	it("resolving a nonexistent timestamp matches nothing", async () => {
		const env = racyEnv();
		await appendFeedback(env, "issue", "note");
		expect(await resolveFeedback(env, 1)).toBe(0);
	});

	it("is idempotent — resolving an already-resolved entry again matches nothing further", async () => {
		const env = racyEnv();
		const { at } = await appendFeedback(env, "issue", "note");
		expect(await resolveFeedback(env, at)).toBe(1);
		expect(await resolveFeedback(env, at)).toBe(0);
	});

	it("kind narrows the match when needed", async () => {
		const env = racyEnv();
		const { at } = await appendFeedback(env, "issue", "note");
		expect(await resolveFeedback(env, at, { kind: "suggest" })).toBe(0);
		expect(await resolveFeedback(env, at, { kind: "issue" })).toBe(1);
	});
});
