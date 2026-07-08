import { afterEach, describe, expect, it, vi } from "vitest";

import { youtube } from "./youtube";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const SEARCH = {
	items: [
		{
			id: { videoId: "abc123" },
			snippet: {
				title: "Rickroll",
				channelTitle: "Rick Astley",
				publishedAt: "2009-10-25T06:57:33Z",
				description: "Never gonna give you up.",
				thumbnails: { medium: { url: "https://img/abc.jpg" } },
			},
		},
	],
};

const VIDEOS = {
	items: [{ id: "abc123", statistics: { viewCount: "1500000000", likeCount: "16000000" }, contentDetails: { duration: "PT3M33S" } }],
};

function installFetch() {
	const calls = { urls: [] as string[] };
	const f = vi.fn(async (input: any) => {
		const url = String(input);
		calls.urls.push(url);
		if (url.includes("/youtube/v3/videos")) return json(VIDEOS);
		if (url.includes("/youtube/v3/search")) return json(SEARCH);
		return json({}, 404);
	});
	global.fetch = f as any;
	return { calls };
}

const keyedEnv = () => ({ YOUTUBE_API_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("youtube", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await youtube.run({} as any, { term: "rickroll" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/YOUTUBE_API_KEY/);
	});

	it("normalizes search items and enriches them with video stats", async () => {
		const { calls } = installFetch();
		const r = await youtube.run(keyedEnv(), { term: "rickroll", max_results: 5 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.videos[0]).toMatchObject({
			id: "abc123",
			title: "Rickroll",
			channel: "Rick Astley",
			published: "2009-10-25T06:57:33Z",
			description: "Never gonna give you up.",
			thumbnail: "https://img/abc.jpg",
			url: "https://youtube.com/watch?v=abc123",
			views: 1500000000,
			likes: 16000000,
			duration: "PT3M33S",
		});
		expect(calls.urls[0]).toContain("q=rickroll");
		expect(calls.urls[0]).toContain("maxResults=5");
		expect(calls.urls[0]).toContain("key=KEY");
		expect(calls.urls[1]).toContain("id=abc123");
	});

	it("still returns search results when the enrich call fails", async () => {
		const f = vi.fn(async (input: any) => {
			const url = String(input);
			if (url.includes("/youtube/v3/videos")) return json({ error: "quota" }, 403);
			return json(SEARCH);
		});
		global.fetch = f as any;
		const r = await youtube.run(keyedEnv(), { term: "rickroll" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.videos[0].id).toBe("abc123");
		expect(j.videos[0].views).toBeUndefined();
	});

	it("carries the upstream HTTP status into the failure message", async () => {
		global.fetch = vi.fn(async () => json({ error: "bad" }, 400)) as any;
		const r = await youtube.run(keyedEnv(), { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 400/);
	});
});
