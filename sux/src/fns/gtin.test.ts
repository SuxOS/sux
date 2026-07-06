import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({ smartFetch: vi.fn() }));

import { gtin, validGtin } from "./gtin";

describe("gtin", () => {
	it("validates check digits correctly", () => {
		expect(validGtin("4006381333931")).toBe(true); // EAN-13
		expect(validGtin("036000291452")).toBe(true); // UPC-12
		expect(validGtin("00012345600012")).toBe(true); // GTIN-14
		expect(validGtin("4006381333930")).toBe(false); // bad check digit
		expect(validGtin("12345")).toBe(false); // wrong length
	});

	it("pulls gtins from JSON-LD and separates valid from candidates", async () => {
		const html = `<script type="application/ld+json">
			{"@type":"Product","gtin13":"4006381333931","gtin12":"036000291452"}
		</script>`;
		const r = await gtin.run({} as any, { html });
		const out = JSON.parse(r.content[0].text);
		expect(out.valid).toContain("4006381333931");
		expect(out.valid).toContain("036000291452");
		expect(out.candidates).toEqual(expect.arrayContaining(out.valid));
	});

	it("collects standalone runs but only reports mod-10-valid ones", async () => {
		const html = `<p>Barcode 4006381333931 (good) and 4006381333930 (bad).</p>`;
		const r = await gtin.run({} as any, { html });
		const out = JSON.parse(r.content[0].text);
		expect(out.candidates).toContain("4006381333931");
		expect(out.candidates).toContain("4006381333930");
		expect(out.valid).toEqual(["4006381333931"]);
	});

	it("errors without html or url", async () => {
		const r = await gtin.run({} as any, {});
		expect(r.isError).toBe(true);
	});
});
