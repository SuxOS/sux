import { describe, expect, it } from "vitest";
import { appendFeedback, readFeedback } from "./_feedback";
import { feedback_resolve } from "./feedback_resolve";

function fakeEnv() {
	const store = new Map<string, string>();
	return { OAUTH_KV: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } } as any;
}

describe("feedback_resolve", () => {
	it("rejects a missing/unparseable `at`", async () => {
		expect((await feedback_resolve.run(fakeEnv(), {})).isError).toBe(true);
		expect((await feedback_resolve.run(fakeEnv(), { at: "not-a-date" })).isError).toBe(true);
	});

	it("resolves an entry by its numeric `at` and hides it from the default feedback view", async () => {
		const env = fakeEnv();
		const { at } = await appendFeedback(env, "issue", "dns broke");
		const r = await feedback_resolve.run(env, { at, tracked_by: "https://github.com/x/y/issues/9" });
		expect(r.isError).toBeFalsy();
		expect(JSON.parse(r.content[0].text)).toMatchObject({ resolved: 1, tracked_by: "https://github.com/x/y/issues/9" });
		expect(await readFeedback(env, "issue")).toHaveLength(0);
		expect((await readFeedback(env, "issue", 50, undefined, true))[0].resolved?.tracked_by).toBe("https://github.com/x/y/issues/9");
	});

	it("also accepts `at` as the ISO string GET /feedback prints (round-trips to the same entry)", async () => {
		const env = fakeEnv();
		const { at } = await appendFeedback(env, "issue", "dns broke");
		const iso = new Date(at).toISOString();
		const r = await feedback_resolve.run(env, { at: iso });
		expect(r.isError).toBeFalsy();
		expect(await readFeedback(env, "issue")).toHaveLength(0);
	});

	it("fails when nothing matches `at` (and optional `kind`)", async () => {
		const env = fakeEnv();
		await appendFeedback(env, "issue", "note");
		expect((await feedback_resolve.run(env, { at: 1 })).isError).toBe(true);
	});
});
