import { describe, expect, it } from "vitest";
import { htmlMarkdown } from "./html_markdown";

describe("html_markdown", () => {
	it("converts HTML to Markdown (headings, links, bold, lists)", async () => {
		const html =
			"<h1>Title</h1><p>Hello <strong>world</strong> and <a href='https://x.com'>link</a>.</p><ul><li>one</li><li>two</li></ul>";
		const r = await htmlMarkdown.run({} as any, { data: html });
		const md = r.content[0].text;
		expect(r.isError).toBeUndefined();
		expect(md).toContain("# Title");
		expect(md).toContain("**world**");
		expect(md).toContain("[link](https://x.com)");
		expect(md).toContain("- one");
		expect(md).toContain("- two");
	});

	it("converts Markdown to HTML (same subset)", async () => {
		const md = "## Heading\n\nText with **bold** and `code`.\n\n1. a\n2. b";
		const r = await htmlMarkdown.run({} as any, { data: md, direction: "md_to_html" });
		const html = r.content[0].text;
		expect(html).toContain("<h2>Heading</h2>");
		expect(html).toContain("<strong>bold</strong>");
		expect(html).toContain("<code>code</code>");
		expect(html).toContain("<ol><li>a</li><li>b</li></ol>");
	});

	it("preserves fenced code blocks round-tripping md->html", async () => {
		const md = "```\nconst x = 1 < 2;\n```";
		const r = await htmlMarkdown.run({} as any, { data: md, direction: "md_to_html" });
		expect(r.content[0].text).toContain("<pre><code>const x = 1 &lt; 2;</code></pre>");
	});

	it("rejects empty data", async () => {
		const r = await htmlMarkdown.run({} as any, { data: "   " });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/required/);
	});
});
