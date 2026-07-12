import { describe, expect, it, vi } from "vitest";

import { listExamples, putExample, type Example } from "./_examples";

const PREFIX = "sux:learn:example:";

/** A Map-backed OAUTH_KV whose list() honors list_complete so we can prove listExamples stops at
 *  one page. `complete` controls whether the returned page claims to be the last one. */
function makeKv(complete = true) {
	const store = new Map<string, string>();
	return {
		store,
		get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
			keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: complete as boolean,
			cursor: complete ? undefined : "next",
		})),
	};
}

const mkEx = (id: string, ts: number): Example => ({ id, input: `in-${id}`, label: "L", batch: "B", ts });

describe("listExamples", () => {
	it("fetches every stored value (in parallel batches) and returns them ts-sorted", async () => {
		const kv = makeKv();
		const env = { OAUTH_KV: kv } as any;
		// Insert out of ts order to prove the sort; enough to span more than one GET batch.
		for (let i = 60; i >= 1; i--) await putExample(env, mkEx(String(i), i));

		const out = await listExamples(env);
		expect(out).toHaveLength(60);
		expect(out.map((e) => e.ts)).toEqual([...out.map((e) => e.ts)].sort((a, b) => a - b));
		expect(out[0].ts).toBe(1);
		expect(out[out.length - 1].ts).toBe(60);
		// One get per key — the values really were read, not just the keys listed.
		expect(kv.get).toHaveBeenCalledTimes(60);
	});

	it("caps at a single KV list page — never paginates past it", async () => {
		const kv = makeKv(false); // page claims more keys remain
		const env = { OAUTH_KV: kv } as any;
		for (let i = 1; i <= 5; i++) await putExample(env, mkEx(String(i), i));

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		await listExamples(env);
		warn.mockRestore();

		// Exactly one list() call despite list_complete:false + a non-null cursor.
		expect(kv.list).toHaveBeenCalledTimes(1);
	});

	it("returns [] with no KV binding", async () => {
		expect(await listExamples({} as any)).toEqual([]);
	});
});
