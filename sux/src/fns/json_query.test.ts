import { describe, expect, it } from "vitest";
import { json_query } from "./json_query";

const doc = JSON.stringify({
	a: { b: [{ c: 1 }, { c: 2 }] },
	items: [{ name: "x" }, { name: "y" }, { name: "z" }],
});

describe("json_query", () => {
	it("resolves a dotted path with an index", async () => {
		const r = await json_query.run({} as any, { data: doc, path: "a.b[0].c" });
		expect(r.isError).toBeUndefined();
		expect(JSON.parse(r.content[0].text)).toBe(1);
	});

	it("maps over a wildcard and tolerates a leading $", async () => {
		const r = await json_query.run({} as any, { data: doc, path: "$.items[*].name" });
		expect(JSON.parse(r.content[0].text)).toEqual(["x", "y", "z"]);
	});

	it("fails on a missing key", async () => {
		const r = await json_query.run({} as any, { data: doc, path: "a.nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not found/);
	});

	it("fails on invalid JSON input", async () => {
		const r = await json_query.run({} as any, { data: "{not json", path: "a" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not valid JSON/);
	});

	it("fails when indexing a non-array", async () => {
		const r = await json_query.run({} as any, { data: doc, path: "a.b[9].c" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/out of range/);
	});
});
