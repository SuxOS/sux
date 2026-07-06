import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(
		async () =>
			new Response(
				`<html><body>Reach us at Sales@Example.com or call (415) 555-2671.</body></html>`,
				{ status: 200 },
			),
	),
}));

import { contacts } from "./contacts";

describe("contacts", () => {
	it("pulls emails and phones from plain text, deduped and lowercased", async () => {
		const text = "Email JOHN@foo.com or john@foo.com, phone +1 202 555 0134 and +442071838750.";
		const r = await contacts.run({} as any, { text });
		const out = JSON.parse(r.content[0].text);
		expect(out.emails).toEqual(["john@foo.com"]);
		expect(out.phones).toContain("+1 202 555 0134");
		expect(out.phones).toContain("+442071838750");
	});

	it("strips html before scanning and normalizes email case", async () => {
		const html = `<div>Contact: <b>Info@Site.io</b> tel <span>212.555.0100</span></div>`;
		const r = await contacts.run({} as any, { html });
		const out = JSON.parse(r.content[0].text);
		expect(out.emails).toEqual(["info@site.io"]);
		expect(out.phones).toContain("212.555.0100");
	});

	it("fetches a url via the proxy and scans it", async () => {
		const r = await contacts.run({} as any, { url: "https://example.com" });
		const out = JSON.parse(r.content[0].text);
		expect(out.emails).toEqual(["sales@example.com"]);
		expect(out.phones).toContain("(415) 555-2671");
	});

	it("errors when nothing is provided", async () => {
		const r = await contacts.run({} as any, {});
		expect(r.isError).toBe(true);
	});
});
