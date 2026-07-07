import { afterEach, describe, expect, it, vi } from "vitest";

import { nyt } from "./nyt";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RESPONSE = {
	response: {
		docs: [
			{
				headline: { main: "Markets Rally" },
				abstract: "Stocks climbed on Tuesday.",
				web_url: "https://www.nytimes.com/markets.html",
				pub_date: "2026-07-01T12:00:00Z",
				byline: { original: "By Jane Doe" },
				section_name: "Business",
			},
		],
	},
};

function installFetch() {
	const calls = { urls: [] as string[] };
	const f = vi.fn(async (input: any) => {
		const url = String(input);
		calls.urls.push(url);
		if (url.includes("/articlesearch.json")) return json(RESPONSE);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls };
}

const keyedEnv = () => ({ NYT_API_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("nyt", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await nyt.run({} as any, { term: "markets" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/NYT_API_KEY/);
	});

	it("normalizes article-search docs", async () => {
		const { calls } = installFetch();
		const r = await nyt.run(keyedEnv(), { term: "markets", limit: 5 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.articles[0]).toMatchObject({
			title: "Markets Rally",
			abstract: "Stocks climbed on Tuesday.",
			url: "https://www.nytimes.com/markets.html",
			published: "2026-07-01T12:00:00Z",
			byline: "By Jane Doe",
			section: "Business",
		});
		expect(calls.urls[0]).toContain("q=markets");
		expect(calls.urls[0]).toContain("api-key=KEY");
		expect(calls.urls[0]).toContain("page=0");
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async () => json({ error: "bad" }, 401)) as any;
		const r = await nyt.run(keyedEnv(), { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 401/);
	});
});
