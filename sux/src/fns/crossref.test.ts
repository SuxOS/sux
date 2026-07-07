import { afterEach, describe, expect, it, vi } from "vitest";
import { crossref } from "./crossref";

const BODY = {
	message: {
		items: [
			{
				DOI: "10.1000/xyz123",
				title: ["Attention Is All You Need"],
				author: [
					{ given: "Ada", family: "Lovelace" },
					{ given: "Alan", family: "Turing" },
				],
				"container-title": ["Journal of ML"],
				published: { "date-parts": [[2017, 6, 12]] },
				URL: "https://doi.org/10.1000/xyz123",
				"is-referenced-by-count": 42,
			},
		],
	},
};

afterEach(() => vi.restoreAllMocks());

describe("crossref", () => {
	it("normalizes works into { doi, title, authors, journal, year, citations, url }", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await crossref.run({} as any, { term: "transformers", rows: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		const e = out.results[0];
		expect(e.doi).toBe("10.1000/xyz123");
		expect(e.title).toBe("Attention Is All You Need");
		expect(e.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
		expect(e.journal).toBe("Journal of ML");
		expect(e.year).toBe(2017);
		expect(e.citations).toBe(42);
		expect(e.url).toBe("https://doi.org/10.1000/xyz123");
	});

	it("passes term and rows to the API", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		await crossref.run({} as any, { term: "protein folding", rows: 7 });
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("query=protein+folding");
		expect(url).toContain("rows=7");
	});

	it("errors without a term", async () => {
		const r = await crossref.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
		const r = await crossref.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/500/);
	});
});
