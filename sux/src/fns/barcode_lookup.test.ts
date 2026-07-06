import { afterEach, describe, expect, it, vi } from "vitest";
import { barcodeLookup } from "./barcode_lookup";

afterEach(() => vi.unstubAllGlobals());

describe("barcode_lookup", () => {
	it("returns a product when found", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(
					JSON.stringify({
						status: 1,
						product: {
							product_name: "Nutella",
							brands: "Ferrero",
							categories: "Spreads, Sweet spreads",
							quantity: "400 g",
							image_url: "https://img.example/nutella.jpg",
							nutriscore_grade: "e",
						},
					}),
					{ status: 200 },
				),
			),
		);
		const r = await barcodeLookup.run({} as any, { gtin: "3017620422003" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.found).toBe(true);
		expect(j.name).toBe("Nutella");
		expect(j.brand).toBe("Ferrero");
		expect(j.gtin).toBe("3017620422003");
	});

	it("rejects a non-numeric barcode", async () => {
		const r = await barcodeLookup.run({} as any, { gtin: "not-a-code" });
		expect(r.isError).toBe(true);
	});

	it("reports not-found when status !== 1", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: 0 }), { status: 200 })));
		const r = await barcodeLookup.run({} as any, { gtin: "00000000000000" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.found).toBe(false);
		expect(j.gtin).toBe("00000000000000");
	});
});
