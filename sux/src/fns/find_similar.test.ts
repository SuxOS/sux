import { afterEach, describe, expect, it, vi } from "vitest";

import { find_similar } from "./find_similar";

afterEach(() => vi.clearAllMocks());

describe("find_similar", () => {
	it("errors when EXA_API_KEY is missing", async () => {
		const r = await find_similar.run({} as any, { url: "https://example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/EXA_API_KEY/);
	});

	it("errors when neither url nor query is given", async () => {
		const r = await find_similar.run({ EXA_API_KEY: "k" } as any, {});
		expect(r.isError).toBe(true);
	});

	it("finds similar pages by url (POST /findSimilar)", async () => {
		const fetchMock = vi.fn(async (_u?: any, _i?: any) => new Response(JSON.stringify({ results: [{ title: "T", url: "https://a.com", publishedDate: "2024-01-01", author: "Ada", score: 0.9, id: "1" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await find_similar.run({ EXA_API_KEY: "k" } as any, { url: "https://example.com", num_results: 5 });
		vi.unstubAllGlobals();
		expect(r.isError).toBeFalsy();
		const call = fetchMock.mock.calls[0];
		expect(String(call[0])).toBe("https://api.exa.ai/findSimilar");
		expect((call[1] as any).headers["x-api-key"]).toBe("k");
		expect(JSON.parse((call[1] as any).body)).toEqual({ url: "https://example.com", numResults: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out[0]).toEqual({ title: "T", url: "https://a.com", published: "2024-01-01", author: "Ada", score: 0.9 });
	});

	it("runs a neural search by query (POST /search)", async () => {
		const fetchMock = vi.fn(async (_u?: any, _i?: any) => new Response(JSON.stringify({ results: [{ title: "Q", url: "https://q.com" }] }), { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await find_similar.run({ EXA_API_KEY: "k" } as any, { query: "neural nets" });
		vi.unstubAllGlobals();
		expect(r.isError).toBeFalsy();
		const call = fetchMock.mock.calls[0];
		expect(String(call[0])).toBe("https://api.exa.ai/search");
		expect(JSON.parse((call[1] as any).body)).toEqual({ query: "neural nets", numResults: 10, type: "neural" });
		const out = JSON.parse(r.content[0].text);
		expect(out[0]).toEqual({ title: "Q", url: "https://q.com", published: null, author: null, score: null });
	});
});
