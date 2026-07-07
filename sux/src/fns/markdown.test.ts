import { describe, expect, it } from "vitest";
import { markdown } from "./markdown";
import { html } from "./html";

const mrun = async (args: any) => (await markdown.run({} as any, args)).content[0].text;
const hrun = async (args: any) => (await html.run({} as any, args)).content[0].text;

describe("markdown (HTML -> Markdown)", () => {
	it("converts headings, links, and emphasis", async () => {
		expect(await mrun({ data: "<h2>Title</h2>" })).toBe("## Title");
		expect(await mrun({ data: '<p>see <a href="http://x">link</a> and <strong>bold</strong></p>' })).toBe("see [link](http://x) and **bold**");
	});

	it("converts lists", async () => {
		expect(await mrun({ data: "<ul><li>a</li><li>b</li></ul>" })).toBe("- a\n- b");
	});

	it("errors on empty data", async () => {
		expect((await markdown.run({} as any, { data: "" })).isError).toBe(true);
	});
});

describe("html (Markdown -> HTML)", () => {
	it("converts headings and paragraphs", async () => {
		expect(await hrun({ data: "# Hi" })).toBe("<h1>Hi</h1>");
		expect(await hrun({ data: "a **b** c" })).toBe("<p>a <strong>b</strong> c</p>");
	});

	it("escapes a quote in a link URL so it can't break out of the href attribute", async () => {
		// A link URL carrying a double quote must not inject a new attribute (e.g.
		// an onmouseover handler) into the emitted <a> tag.
		const out = await hrun({ data: '[x](" onmouseover="alert(1))' });
		// The payload's quotes must be escaped (not left as real attribute
		// delimiters), so no live onmouseover="" attribute is emitted.
		expect(out).not.toContain('onmouseover="');
		expect(out).toContain("&quot;");
	});
});

describe("markdown/html compose (bidirectionality)", () => {
	it("markdown(html(md)) round-trips a document", async () => {
		const md = "## Heading\n\nA para with **bold** and a [link](http://x).\n\n- one\n- two";
		expect(await mrun({ data: await hrun({ data: md }) })).toBe(md);
	});
});
