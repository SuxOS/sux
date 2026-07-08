import { afterEach, describe, expect, it, vi } from "vitest";
import { arxiv } from "./arxiv";

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/2101.00001v1</id>
    <updated>2021-01-01T00:00:00Z</updated>
    <published>2021-01-01T00:00:00Z</published>
    <title>Attention Is All You Need &amp; More</title>
    <summary>A study of transformers and self-attention.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan Turing</name></author>
    <link href="http://arxiv.org/abs/2101.00001v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/2101.00001v1" rel="related" type="application/pdf"/>
    <category term="cs.LG" scheme="http://arxiv.org/schemas/atom"/>
    <category term="cs.CL" scheme="http://arxiv.org/schemas/atom"/>
  </entry>
</feed>`;

afterEach(() => vi.restoreAllMocks());

describe("arxiv", () => {
	it("parses Atom entries into normalized results", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ATOM, { status: 200 }));
		const r = await arxiv.run({} as any, { term: "transformers", max_results: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		const e = out.results[0];
		expect(e.id).toBe("http://arxiv.org/abs/2101.00001v1");
		expect(e.title).toBe("Attention Is All You Need & More");
		expect(e.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
		expect(e.summary).toMatch(/transformers/);
		expect(e.published).toBe("2021-01-01T00:00:00Z");
		expect(e.url).toBe("http://arxiv.org/abs/2101.00001v1");
		expect(e.pdf_url).toBe("http://arxiv.org/pdf/2101.00001v1");
		expect(e.categories).toEqual(["cs.LG", "cs.CL"]);
	});

	it("passes term, max_results and sort_by to the API", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ATOM, { status: 200 }));
		await arxiv.run({} as any, { term: "quantum computing", max_results: 3, sort_by: "submittedDate" });
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("search_query=all%3Aquantum+computing");
		expect(url).toContain("max_results=3");
		expect(url).toContain("sortBy=submittedDate");
	});

	it("errors without a term", async () => {
		const r = await arxiv.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
		const r = await arxiv.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/503/);
	});
});
