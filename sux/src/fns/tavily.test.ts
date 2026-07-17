import { afterEach, describe, expect, it, vi } from "vitest";

import { tavily } from "./tavily";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RESULT = {
	answer: "The capital of France is Paris.",
	results: [
		{ title: "Paris", url: "https://en.wikipedia.org/wiki/Paris", content: "Paris is the capital of France.", score: 0.98 },
		{ title: "France", url: "https://en.wikipedia.org/wiki/France", content: "France is a country.", score: 0.71 },
	],
};

const keyedEnv = () => ({ TAVILY_API_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("tavily", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await tavily.run({} as any, { query: "capital of france" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/TAVILY_API_KEY/);
	});

	it("returns the answer plus normalized results and posts the expected body", async () => {
		let body: any;
		global.fetch = vi.fn(async (_u: any, init: any) => {
			body = JSON.parse(init.body);
			return json(RESULT);
		}) as any;
		const r = await tavily.run(keyedEnv(), { query: "capital of france", limit: 5, depth: "advanced" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.answer).toBe("The capital of France is Paris.");
		expect(j.count).toBe(2);
		expect(j.results[0]).toMatchObject({ title: "Paris", url: "https://en.wikipedia.org/wiki/Paris", score: 0.98 });
		expect(body).toMatchObject({ api_key: "KEY", query: "capital of france", max_results: 5, include_answer: true, search_depth: "advanced" });
	});

	it("defaults depth to basic and max_results to 8", async () => {
		let body: any;
		global.fetch = vi.fn(async (_u: any, init: any) => {
			body = JSON.parse(init.body);
			return json(RESULT);
		}) as any;
		await tavily.run(keyedEnv(), { query: "x" });
		expect(body.search_depth).toBe("basic");
		expect(body.max_results).toBe(8);
	});

	it("carries upstream HTTP status into the failure", async () => {
		global.fetch = vi.fn(async () => json({ error: "bad" }, 401)) as any;
		const r = await tavily.run(keyedEnv(), { query: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 401/);
	});
});
