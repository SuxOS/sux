import { afterEach, describe, expect, it, vi } from "vitest";

const URLSET = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://ex.com/a</loc></url>
  <url><loc>https://ex.com/b?x=1&amp;y=2</loc></url>
</urlset>`;

const INDEX = `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://ex.com/sitemap-1.xml</loc></sitemap>
  <sitemap><loc>https://ex.com/sitemap-2.xml</loc></sitemap>
</sitemapindex>`;

const smartFetch = vi.fn(async () => new Response(URLSET, { status: 200 }));
vi.mock("../proxy", () => ({ smartFetch: (...a: any[]) => smartFetch(...(a as [])) }));

import { sitemap } from "./sitemap";

afterEach(() => smartFetch.mockReset());

describe("sitemap", () => {
	it("parses a urlset and decodes &amp; in locs", async () => {
		smartFetch.mockResolvedValue(new Response(URLSET, { status: 200 }));
		const r = await sitemap.run({} as any, { url: "https://ex.com/sitemap.xml" });
		const out = JSON.parse(r.content[0].text);
		expect(out.kind).toBe("urlset");
		expect(out.count).toBe(2);
		expect(out.urls).toContain("https://ex.com/b?x=1&y=2");
	});

	it("flags a sitemapindex and lists child sitemaps", async () => {
		smartFetch.mockResolvedValue(new Response(INDEX, { status: 200 }));
		const r = await sitemap.run({} as any, { url: "https://ex.com/sitemap.xml" });
		const out = JSON.parse(r.content[0].text);
		expect(out.kind).toBe("sitemapindex");
		expect(out.urls).toEqual(["https://ex.com/sitemap-1.xml", "https://ex.com/sitemap-2.xml"]);
	});

	it("rejects a non-http url", async () => {
		const r = await sitemap.run({} as any, { url: "ftp://ex.com/s.xml" });
		expect(r.isError).toBe(true);
	});
});
