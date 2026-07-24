import { afterEach, describe, expect, it, vi } from "vitest";
import { cms_coverage } from "./cms_coverage";

const BODY = {
	data: [{ documentDisplayId: "NCD-100.1", documentTitle: "Widget Therapy Coverage", status: "Active", effectiveDate: "2020-01-01" }],
};

afterEach(() => vi.restoreAllMocks());

describe("cms_coverage", () => {
	it("normalizes results into { kind, id, title, status, effective_date, url }", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await cms_coverage.run({} as any, { keyword: "widget therapy" });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		const e = out.results[0];
		expect(e.kind).toBe("ncd");
		expect(e.id).toBe("NCD-100.1");
		expect(e.title).toBe("Widget Therapy Coverage");
		expect(e.url).toContain("NCD-100.1");
	});

	it("errors without a keyword", async () => {
		const r = await cms_coverage.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 502 }));
		const r = await cms_coverage.run({} as any, { keyword: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/502/);
	});
});
