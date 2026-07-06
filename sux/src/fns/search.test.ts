import { describe, expect, it, vi } from "vitest";

vi.mock("../kagi", () => ({
	kagiTool: vi.fn(async (_env: any, _name: string, args: any) => {
		if (args.query === "boom") return { content: [{ text: "err" }], isError: true };
		return { content: [{ text: `## Search Results\n### [Result](https://x.com)\nfor ${args.query} limit=${args.limit} wf=${args.workflow}` }] };
	}),
}));

import { search } from "./search";

describe("search", () => {
	it("rejects an empty query", async () => {
		const r = await search.run({} as any, { query: "   " });
		expect(r.isError).toBe(true);
	});
	it("returns Kagi results and passes limit/workflow", async () => {
		const r = await search.run({} as any, { query: "cats", limit: 5, workflow: "news" });
		expect(r.content[0].text).toContain("Search Results");
		expect(r.content[0].text).toContain("limit=5");
		expect(r.content[0].text).toContain("wf=news");
	});
	it("surfaces upstream errors", async () => {
		const r = await search.run({} as any, { query: "boom" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Search failed/);
	});
});
