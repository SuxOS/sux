import { afterEach, describe, expect, it, vi } from "vitest";
import { semantic_scholar } from "./semantic_scholar";

const BODY = {
	total: 1,
	data: [
		{
			paperId: "abc123",
			title: "Deep Residual Learning",
			abstract: "We present a residual learning framework.",
			year: 2015,
			authors: [{ name: "Kaiming He" }, { name: "Xiangyu Zhang" }],
			citationCount: 99999,
			url: "https://www.semanticscholar.org/paper/abc123",
			externalIds: { DOI: "10.1/resnet" },
			openAccessPdf: { url: "https://arxiv.org/pdf/1512.03385" },
		},
	],
};

afterEach(() => vi.restoreAllMocks());

describe("semantic_scholar", () => {
	it("normalizes papers into { id, title, abstract, year, authors, citations, url, pdf }", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await semantic_scholar.run({} as any, { term: "resnet", limit: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		const e = out.results[0];
		expect(e.id).toBe("abc123");
		expect(e.title).toBe("Deep Residual Learning");
		expect(e.abstract).toMatch(/residual/);
		expect(e.year).toBe(2015);
		expect(e.authors).toEqual(["Kaiming He", "Xiangyu Zhang"]);
		expect(e.citations).toBe(99999);
		expect(e.url).toBe("https://www.semanticscholar.org/paper/abc123");
		expect(e.pdf).toBe("https://arxiv.org/pdf/1512.03385");
	});

	it("passes term, limit and fields, and no api key header when unset", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		await semantic_scholar.run({} as any, { term: "graph neural networks", limit: 3 });
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("query=graph+neural+networks");
		expect(url).toContain("limit=3");
		expect(url).toContain("fields=");
		const headers = (spy.mock.calls[0][1] as any)?.headers ?? {};
		expect(headers["x-api-key"]).toBeUndefined();
	});

	it("sends the x-api-key header when S2_API_KEY is set", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		await semantic_scholar.run({ S2_API_KEY: "secret" } as any, { term: "x" });
		const headers = (spy.mock.calls[0][1] as any)?.headers ?? {};
		expect(headers["x-api-key"]).toBe("secret");
	});

	it("errors without a term", async () => {
		const r = await semantic_scholar.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 429 }));
		const r = await semantic_scholar.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/429/);
	});
});
