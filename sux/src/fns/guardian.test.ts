import { afterEach, describe, expect, it, vi } from "vitest";

import { guardian } from "./guardian";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RESPONSE = {
	response: {
		results: [
			{
				webTitle: "Climate report",
				webUrl: "https://www.theguardian.com/climate.html",
				webPublicationDate: "2026-07-02T09:00:00Z",
				sectionName: "Environment",
				fields: { trailText: "A sobering read.", thumbnail: "https://img/climate.jpg", byline: "Alex Green" },
			},
		],
	},
};

function installFetch() {
	const calls = { urls: [] as string[] };
	const f = vi.fn(async (input: any) => {
		const url = String(input);
		calls.urls.push(url);
		if (url.includes("content.guardianapis.com/search")) return json(RESPONSE);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls };
}

const keyedEnv = () => ({ GUARDIAN_API_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("guardian", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await guardian.run({} as any, { term: "climate" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/GUARDIAN_API_KEY/);
	});

	it("normalizes search results including show-fields", async () => {
		const { calls } = installFetch();
		const r = await guardian.run(keyedEnv(), { term: "climate", page_size: 5 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.results[0]).toMatchObject({
			title: "Climate report",
			url: "https://www.theguardian.com/climate.html",
			published: "2026-07-02T09:00:00Z",
			section: "Environment",
			summary: "A sobering read.",
			thumbnail: "https://img/climate.jpg",
			byline: "Alex Green",
		});
		expect(calls.urls[0]).toContain("q=climate");
		expect(calls.urls[0]).toContain("api-key=KEY");
		expect(calls.urls[0]).toContain("page-size=5");
		expect(calls.urls[0]).toContain("show-fields=trailText");
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async () => json({ error: "bad" }, 403)) as any;
		const r = await guardian.run(keyedEnv(), { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 403/);
	});
});
