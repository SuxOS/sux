import { describe, expect, it } from "vitest";
import { kv_delete } from "./kv_delete";

function fakeEnv(seed: Record<string, string> = {}) {
	const store = new Map(Object.entries(seed));
	const env = {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
			list: async ({ prefix }: { prefix?: string } = {}) => ({
				keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			}),
		},
	} as any;
	return { env, store };
}

describe("kv_delete", () => {
	it("refuses to delete an internal reserved key", async () => {
		const { env, store } = fakeEnv({ "sux:internal": "keep" });
		const r = await kv_delete.run(env, { key: "sux:internal" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/reserved space/);
		expect(store.get("sux:internal")).toBe("keep");
	});

	it("deletes a namespaced key", async () => {
		const { env, store } = fakeEnv({ "kv:doomed": "bye" });
		const r = await kv_delete.run(env, { key: "doomed" });
		expect(r.isError).toBeFalsy();
		expect(store.has("kv:doomed")).toBe(false);
		expect(r.content[0].text).toMatch(/Deleted 'doomed'/);
	});

	it("is idempotent — deleting a missing key still confirms", async () => {
		const { env } = fakeEnv();
		const r = await kv_delete.run(env, { key: "ghost" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/Deleted 'ghost'/);
	});

	it("rejects an empty key", async () => {
		const { env } = fakeEnv();
		const r = await kv_delete.run(env, { key: "   " });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/non-empty/);
	});
});
