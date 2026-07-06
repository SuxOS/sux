import { afterEach, describe, expect, it, vi } from "vitest";
import { pubmed } from "./pubmed";

afterEach(() => vi.unstubAllGlobals());

function stub(esearchIds: string[], summary: Record<string, any>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (u: string) => {
			if (u.includes("esearch")) return new Response(JSON.stringify({ esearchresult: { idlist: esearchIds } }), { status: 200 });
			return new Response(JSON.stringify({ result: summary }), { status: 200 });
		}),
	);
}

describe("pubmed", () => {
	it("rejects an empty query", async () => {
		const r = await pubmed.run({} as any, { query: "  " });
		expect(r.isError).toBe(true);
	});

	it("distills esearch+esummary into a citable list", async () => {
		stub(["123"], {
			"123": {
				title: "CRISPR off-target effects",
				authors: [{ name: "Doe J" }, { name: "Roe A" }],
				fulljournalname: "Nature",
				sortpubdate: "2023/05/01",
				articleids: [{ idtype: "doi", value: "10.1/x" }],
			},
		});
		const r = await pubmed.run({} as any, { query: "crispr", limit: 5 });
		expect(r.content[0].text).toContain("CRISPR off-target effects");
		expect(r.content[0].text).toContain("PMID 123");
		expect(r.content[0].text).toContain("doi:10.1/x");
		expect(r.content[0].text).toContain("(2023)");
	});

	it("collapses long author lists to et al.", async () => {
		stub(["9"], { "9": { title: "T", authors: [{ name: "A" }, { name: "B" }, { name: "C" }, { name: "D" }], sortpubdate: "2020" } });
		const r = await pubmed.run({} as any, { query: "x" });
		expect(r.content[0].text).toContain("et al.");
	});

	it("reports no results cleanly", async () => {
		stub([], {});
		const r = await pubmed.run({} as any, { query: "zzznope" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/No PubMed results/);
	});
});
