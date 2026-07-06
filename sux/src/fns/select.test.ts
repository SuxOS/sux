import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("<html></html>", { status: 200 })),
}));

import { select } from "./select";

const HTML = `<html><body>
  <div class="post"><h2>Title A</h2><a href="/a" class="link">Read A</a></div>
  <div class="post featured"><h2>Title B</h2><a href="/b" class="link">Read B</a></div>
  <p id="foot">footer</p>
</body></html>`;

describe("select", () => {
	it("returns text for a class selector", async () => {
		const r = await select.run({} as any, { html: HTML, selector: "h2" });
		const out = JSON.parse(r.content[0].text);
		expect(out).toEqual(["Title A", "Title B"]);
	});

	it("returns an attribute with `attr`", async () => {
		const r = await select.run({} as any, { html: HTML, selector: "a.link", attr: "href" });
		expect(JSON.parse(r.content[0].text)).toEqual(["/a", "/b"]);
	});

	it("supports descendant combinators", async () => {
		const r = await select.run({} as any, { html: HTML, selector: "div.featured a" });
		expect(JSON.parse(r.content[0].text)).toEqual(["Read B"]);
	});

	it("supports comma lists and de-dupes", async () => {
		const r = await select.run({} as any, { html: HTML, selector: "#foot, p" });
		expect(JSON.parse(r.content[0].text)).toEqual(["footer"]);
	});

	it("returns [] for no match and errors without a selector", async () => {
		const none = await select.run({} as any, { html: HTML, selector: "table" });
		expect(none.content[0].text).toBe("[]");
		const bad = await select.run({} as any, { html: HTML, selector: "" });
		expect(bad.isError).toBe(true);
	});
});
