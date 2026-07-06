import { describe, expect, it } from "vitest";
import { dedupe } from "./dedupe";

describe("dedupe", () => {
	it("dedupes text lines preserving order", async () => {
		const r = await dedupe.run({} as any, { data: "a\nb\na\nc\nb" });
		const out = JSON.parse(r.content[0].text);
		expect(out.kept).toBe(3);
		expect(out.removed).toBe(2);
		expect(out.result).toBe("a\nb\nc");
	});

	it("dedupes a JSON array by a key, keeping last", async () => {
		const data = JSON.stringify([
			{ id: 1, v: "a" },
			{ id: 2, v: "b" },
			{ id: 1, v: "c" },
		]);
		const r = await dedupe.run({} as any, { data, mode: "json", by: "id", keep: "last" });
		const out = JSON.parse(r.content[0].text);
		expect(out.kept).toBe(2);
		expect(out.removed).toBe(1);
		expect(out.result).toEqual([{ id: 1, v: "c" }, { id: 2, v: "b" }]);
	});

	it("dedupes whole JSON items regardless of key order", async () => {
		const data = JSON.stringify([{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 9 }]);
		const r = await dedupe.run({} as any, { data, mode: "json" });
		const out = JSON.parse(r.content[0].text);
		expect(out.kept).toBe(2);
		expect(out.removed).toBe(1);
	});

	it("errors on non-array json input", async () => {
		const r = await dedupe.run({} as any, { data: '{"x":1}', mode: "json" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/JSON array/);
	});
});
