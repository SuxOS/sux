import { describe, expect, it } from "vitest";
import { kv_list } from "./kv_list";

function fakeEnv(seed: Record<string, string> = {}) {
	const store = new Map(Object.entries(seed));
	return {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
			list: async ({ prefix }: { prefix?: string } = {}) => ({
				keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			}),
		},
	} as any;
}

describe("kv_list", () => {
	it("lists only kv: keys with the prefix stripped, ignoring internal keys", async () => {
		const env = fakeEnv({ "kv:a": "1", "kv:b": "2", "cache:secret": "x", "oauth:tok": "y" });
		const r = await kv_list.run(env, {});
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text)).toEqual({ keys: ["a", "b"] });
	});

	it("applies a user prefix scoped inside the namespace", async () => {
		const env = fakeEnv({ "kv:user:1": "a", "kv:user:2": "b", "kv:other": "c" });
		const r = await kv_list.run(env, { prefix: "user:" });
		expect(JSON.parse(r.content[0].text)).toEqual({ keys: ["user:1", "user:2"] });
	});

	it("returns sorted keys regardless of insertion order", async () => {
		const env = fakeEnv({ "kv:zebra": "1", "kv:apple": "2", "kv:mango": "3" });
		const r = await kv_list.run(env, {});
		expect(JSON.parse(r.content[0].text)).toEqual({ keys: ["apple", "mango", "zebra"] });
	});

	it("returns an empty list when nothing is stored", async () => {
		const r = await kv_list.run(fakeEnv(), {});
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text)).toEqual({ keys: [] });
	});
});
