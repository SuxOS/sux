import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({ smartFetch: vi.fn() }));

import { smartFetch } from "../proxy";
import { crawl } from "./crawl";

const mockFetch = smartFetch as unknown as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

describe("crawl", () => {
	it("rejects a non-absolute url", async () => {
		const r = await crawl.run({} as any, { url: "example.com/path" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("crawls same-origin links breadth-first and captures titles", async () => {
		mockFetch.mockImplementation(async (_env: unknown, url: string) => {
			if (url === "https://ex.com/") {
				return new Response(`<title> Home </title><a href="https://ex.com/about">a</a><a href="https://other.com/x">off</a>`, { status: 200 });
			}
			return new Response("<title>About</title>", { status: 200 });
		});
		const r = await crawl.run({} as any, { url: "https://ex.com/", depth: 1, max: 25 });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.pages).toBe(2);
		expect(out.results.map((x: any) => x.url)).toEqual(["https://ex.com/", "https://ex.com/about"]);
		expect(out.results[0].title).toBe("Home");
		expect(out.results.some((x: any) => x.url.includes("other.com"))).toBe(false);
	});

	it("stops at depth 0 without following links (edge case)", async () => {
		mockFetch.mockResolvedValue(new Response(`<title>Seed</title><a href="https://ex.com/next">n</a>`, { status: 200 }));
		const r = await crawl.run({} as any, { url: "https://ex.com/", depth: 0 });
		const out = JSON.parse(r.content[0].text);
		expect(out.pages).toBe(1);
		expect(mockFetch).toHaveBeenCalledTimes(1);
	});

	it("returns an empty result set when the seed fetch throws", async () => {
		mockFetch.mockRejectedValue(new Error("network down"));
		const r = await crawl.run({} as any, { url: "https://ex.com/" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.pages).toBe(0);
		expect(out.results).toEqual([]);
	});
});
