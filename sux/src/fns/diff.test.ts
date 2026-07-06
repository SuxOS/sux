import { describe, expect, it } from "vitest";
import { diff } from "./diff";

describe("diff", () => {
	it("summarizes adds and removes with prefixes", async () => {
		const r = await diff.run({} as any, { a: "one\ntwo\nthree", b: "one\n2\nthree" });
		const [summary, ...body] = r.content[0].text.split("\n");
		expect(JSON.parse(summary)).toEqual({ added: 1, removed: 1 });
		expect(body).toContain("  one");
		expect(body).toContain("- two");
		expect(body).toContain("+ 2");
		expect(body).toContain("  three");
	});

	it("reports identical inputs", async () => {
		const r = await diff.run({} as any, { a: "same\ntext", b: "same\ntext" });
		expect(r.content[0].text).toMatch(/"added":0,"removed":0/);
		expect(r.content[0].text).toMatch(/identical/);
	});

	it("limits context lines", async () => {
		const a = "a\nb\nc\nd\nE\nf\ng\nh\ni";
		const b = "a\nb\nc\nd\nX\nf\ng\nh\ni";
		const r = await diff.run({} as any, { a, b, context: 1 });
		const text = r.content[0].text;
		expect(text).toContain("- E");
		expect(text).toContain("+ X");
		expect(text).toContain("…"); // far-away context collapsed
		expect(text).not.toContain("  a"); // first line is >1 away from the change
	});

	it("validates input types", async () => {
		const r = await diff.run({} as any, { a: 5, b: "x" });
		expect(r.isError).toBe(true);
	});
});
