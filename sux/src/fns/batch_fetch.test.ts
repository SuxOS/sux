import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: unknown, url: string) => {
		if (url.includes("boom")) throw new Error("network down");
		return new Response(`body of ${url}`, { status: 200 });
	}),
}));

import { batch_fetch } from "./batch_fetch";

describe("batch_fetch", () => {
	it("rejects a non-array urls value", async () => {
		const r = await batch_fetch.run({} as any, { urls: "http://a.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/`urls` must be an array/);
	});

	it("fetches multiple URLs and returns per-url status/bytes/text", async () => {
		const r = await batch_fetch.run({} as any, { urls: ["https://a.com", "https://b.com"] });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ url: "https://a.com", status: 200 });
		expect(out[0].text).toContain("body of https://a.com");
		expect(out[0].bytes).toBe(out[0].text.length);
	});

	it("flags non-http URLs and isolates per-url fetch failures", async () => {
		const r = await batch_fetch.run({} as any, { urls: ["ftp://nope", "https://boom.com", "https://ok.com"] });
		const out = JSON.parse(r.content[0].text);
		expect(out[0].error).toMatch(/not an absolute http/);
		expect(out[1].error).toMatch(/network down/);
		expect(out[2].status).toBe(200); // survivor
	});

	it("rejects an empty urls array", async () => {
		const r = await batch_fetch.run({} as any, { urls: [] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/must not be empty/);
	});
});
