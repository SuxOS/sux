import { describe, expect, it } from "vitest";
import { sort } from "./sort";

describe("sort", () => {
	it("rejects json mode when data is not an array", async () => {
		const r = await sort.run({} as any, { data: '{"a":1}', mode: "json" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/JSON array/);
	});

	it("sorts lines ascending by default", async () => {
		const r = await sort.run({} as any, { data: "banana\napple\ncherry" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("apple\nbanana\ncherry");
	});

	it("sorts a JSON array of objects numerically desc by a dotted key, with unique", async () => {
		const data = JSON.stringify([
			{ m: { n: "2" } },
			{ m: { n: "10" } },
			{ m: { n: "2" } },
			{ m: { n: "1" } },
		]);
		const r = await sort.run({} as any, { data, mode: "json", by: "m.n", order: "desc", numeric: true, unique: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.map((o: any) => o.m.n)).toEqual(["10", "2", "1"]);
	});

	it("errors on invalid JSON in json mode", async () => {
		const r = await sort.run({} as any, { data: "[not json", mode: "json" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not valid JSON/);
	});
});
