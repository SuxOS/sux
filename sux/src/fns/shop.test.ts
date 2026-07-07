import { describe, expect, it, vi } from "vitest";

// shop renders Google Shopping via the `render` mac backend (through the registry).
const { renderRun } = vi.hoisted(() => ({ renderRun: vi.fn() }));
vi.mock("./index", () => ({ FUNCTIONS: [{ name: "render", run: renderRun }] }));

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

	it("renders Google Shopping via the mac backend (no key) and formats hits", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: card("https://m.example/p", "Drill", "$59.00") }] });
		const r = await shop.run({} as any, { query: "drill" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("1. Drill — $59.00 [m.example]");
		expect(renderRun).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ backend: "mac", solve: true }));
		expect(String(renderRun.mock.calls[0][1].url)).toContain("tbm=shop");
	});

	it("returns a friendly note when nothing parses", async () => {
		renderRun.mockResolvedValueOnce({ content: [{ text: "<html>no products</html>" }] });
		const r = await shop.run({} as any, { query: "xyz" });
		expect(r.content[0].text).toMatch(/no products parsed/);
	});
});
