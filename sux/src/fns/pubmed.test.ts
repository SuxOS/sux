import { afterEach, describe, expect, it, vi } from "vitest";
import { pubmed } from "./pubmed";

const ESEARCH = { esearchresult: { count: "2", idlist: ["111", "222"] } };
const ESUMMARY = {
	result: {
		uids: ["111", "222"],
		"111": {
			uid: "111",
			title: "CRISPR gene editing in practice.",
			authors: [{ name: "Doudna J" }, { name: "Charpentier E" }],
			fulljournalname: "Nature",
			source: "Nature",
			pubdate: "2020 Jan",
			articleids: [{ idtype: "pubmed", value: "111" }, { idtype: "doi", value: "10.1000/abc" }],
		},
		"222": {
			uid: "222",
			title: "A second paper.",
			authors: [{ name: "Smith A" }],
			fulljournalname: "Cell",
			pubdate: "2021 Feb",
			articleids: [{ idtype: "pubmed", value: "222" }],
		},
	},
};

function mockFetch() {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
		const url = String(input);
		if (url.includes("esearch.fcgi")) return new Response(JSON.stringify(ESEARCH), { status: 200 });
		if (url.includes("esummary.fcgi")) return new Response(JSON.stringify(ESUMMARY), { status: 200 });
		return new Response("unexpected", { status: 500 });
	});
}

afterEach(() => vi.restoreAllMocks());

describe("pubmed", () => {
	it("chains esearch + esummary into normalized results", async () => {
		mockFetch();
		const r = await pubmed.run({} as any, { term: "crispr", retmax: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(2);
		const a = out.results[0];
		expect(a.pmid).toBe("111");
		expect(a.title).toBe("CRISPR gene editing in practice.");
		expect(a.authors).toEqual(["Doudna J", "Charpentier E"]);
		expect(a.journal).toBe("Nature");
		expect(a.pubdate).toBe("2020 Jan");
		expect(a.doi).toBe("10.1000/abc");
		expect(a.url).toBe("https://pubmed.ncbi.nlm.nih.gov/111/");
		expect(out.results[1].doi).toBeNull();
	});

	it("appends api_key when NCBI_API_KEY is set", async () => {
		const spy = mockFetch();
		await pubmed.run({ NCBI_API_KEY: "secret" } as any, { term: "cancer" });
		expect(spy.mock.calls.every((c) => String(c[0]).includes("api_key=secret"))).toBe(true);
	});

	it("returns empty results when esearch has no ids", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 }));
		const r = await pubmed.run({} as any, { term: "zzzznotarealterm" });
		expect(JSON.parse(r.content[0].text).count).toBe(0);
	});

	it("errors without a term", async () => {
		const r = await pubmed.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("down", { status: 500 }));
		const r = await pubmed.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
	});
});
