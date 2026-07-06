import { describe, expect, it } from "vitest";
import { kv_put } from "./kv_put";

function fakeEnv() {
	const store = new Map<string, string>();
	const puts: Array<{ key: string; value: string; opts: any }> = [];
	const env = {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string, opts?: any) => {
				puts.push({ key: k, value: v, opts });
				store.set(k, v);
			},
			delete: async (k: string) => void store.delete(k),
			list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
		},
	} as any;
	return { env, store, puts };
}

describe("kv_put", () => {
	it("refuses a key that would land in reserved space", async () => {
		const { env, store } = fakeEnv();
		const r = await kv_put.run(env, { key: "cache:x", value: "v" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/reserved space/);
		expect(store.size).toBe(0);
	});

	it("writes a value under the kv: namespace", async () => {
		const { env, store } = fakeEnv();
		const r = await kv_put.run(env, { key: "color", value: "blue" });
		expect(r.isError).toBeFalsy();
		expect(store.get("kv:color")).toBe("blue");
		expect(r.content[0].text).toMatch(/Wrote 4 bytes/);
	});

	it("passes ttl through as expirationTtl", async () => {
		const { env, puts } = fakeEnv();
		const r = await kv_put.run(env, { key: "tmp", value: "x", ttl: 120 });
		expect(r.isError).toBeFalsy();
		expect(puts[0].opts).toEqual({ expirationTtl: 120 });
		expect(r.content[0].text).toMatch(/expires in 120s/);
	});

	it("rejects a ttl below the KV minimum", async () => {
		const { env, store } = fakeEnv();
		const r = await kv_put.run(env, { key: "tmp", value: "x", ttl: 10 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/ttl must be a number >= 60/);
		expect(store.size).toBe(0);
	});
});
