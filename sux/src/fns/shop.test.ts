import { describe, expect, it, vi } from "vitest";

const { smartFetch } = vi.hoisted(() => ({ smartFetch: vi.fn() }));
vi.mock("../proxy", () => ({ smartFetch }));

import { parseGoogleShopping, shop } from "./shop";

// A product card: anchor to the merchant product page, title, then a nearby price.
const card = (url: string, title: string, price: string) => `<div><a href="${url}">${title}</a><span>4.5★</span><span>${price}</span></div>`;

describe("parseGoogleShopping", () => {
	it("extracts title + price + merchant + link, dedupes, drops google hosts", () => {
		const html = card("https://shop.example/p1", "Widget Pro", "$19.99") + card("https://support.google.com/x", "Google Thing", "$0.00") + card("https://shop.example/p1", "Widget Pro", "$19.99");
		const hits = parseGoogleShopping(html, 10);
		expect(hits).toHaveLength(1);
		expect(hits[0]).toMatchObject({ title: "Widget Pro", price: "$19.99", source: "shop.example", url: "https://shop.example/p1" });
	});
});

describe("shop", () => {
	it("requires a query", async () => {
		expect((await shop.run({} as any, { query: "" })).content[0].text).toMatch(/required/);
	});

	it("redirects a dedicated retailer to its fn", async () => {
		const r = await shop.run({} as any, { query: "tv", store: "walmart" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/dedicated `walmart` fn/);
	});

	it("scrapes Google Shopping directly (no key) and formats hits", async () => {
		smartFetch.mockResolvedValueOnce(new Response(card("https://m.example/p", "Drill", "$59.00"), { status: 200 }));
		const r = await shop.run({} as any, { query: "drill" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. Drill — $59.00 [m.example]");
		expect(String(smartFetch.mock.calls[0][1])).toContain("tbm=shop");
		expect(String(smartFetch.mock.calls[0][1])).not.toContain("serpapi");
	});

	it("returns a friendly note when nothing parses", async () => {
		smartFetch.mockResolvedValueOnce(new Response("<html>no products</html>", { status: 200 }));
		const r = await shop.run({} as any, { query: "xyz" });
		expect(r.content[0].text).toMatch(/no products parsed/);
	});
});
