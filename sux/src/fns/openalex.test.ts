import { afterEach, describe, expect, it, vi } from "vitest";
import { openalex } from "./openalex";

const RESP = {
	results: [
		{
			id: "https://openalex.org/W123",
			display_name: "Deep Residual Learning",
			publication_year: 2016,
			authorships: [
				{ author: { display_name: "Kaiming He" } },
				{ author: { display_name: "Xiangyu Zhang" } },
			],
			doi: "https://doi.org/10.1109/cvpr.2016.90",
			cited_by_count: 200000,
			primary_location: { landing_page_url: "https://example.org/resnet" },
			open_access: { oa_url: "https://arxiv.org/pdf/1512.03385" },
		},
	],
};

afterEach(() => vi.restoreAllMocks());

describe("openalex", () => {
	it("normalizes works", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(RESP), { status: 200 }));
		const r = await openalex.run({} as any, { term: "resnet", per_page: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		const w = out.results[0];
		expect(w.id).toBe("https://openalex.org/W123");
		expect(w.title).toBe("Deep Residual Learning");
		expect(w.year).toBe(2016);
		expect(w.authors).toEqual(["Kaiming He", "Xiangyu Zhang"]);
		expect(w.doi).toBe("https://doi.org/10.1109/cvpr.2016.90");
		expect(w.citations).toBe(200000);
		expect(w.url).toBe("https://example.org/resnet");
		expect(w.oa_url).toBe("https://arxiv.org/pdf/1512.03385");
	});

	it("sends term and per-page to the API", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(RESP), { status: 200 }));
		await openalex.run({} as any, { term: "graph neural network", per_page: 7 });
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("search=graph+neural+network");
		expect(url).toContain("per-page=7");
	});

	it("errors without a term", async () => {
		const r = await openalex.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 429 }));
		const r = await openalex.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/429/);
	});
});
