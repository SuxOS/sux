import { describe, expect, it } from "vitest";
import { flattenFn } from "./flatten";

const run = async (args: any) => {
	const r = await flattenFn.run({} as any, args);
	return { r, out: r.isError ? null : JSON.parse(r.content[0].text) };
};

describe("flatten", () => {
	it("rejects invalid JSON", async () => {
		const { r } = await run({ data: "{not json" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/not valid JSON/);
	});

	it("flattens nested objects and arrays into joined paths", async () => {
		const { out } = await run({ data: JSON.stringify({ a: { b: [10, 20] }, c: "x" }) });
		expect(out).toEqual({ "a.b.0": 10, "a.b.1": 20, c: "x" });
	});

	it("unflatten reverses flatten and revives arrays (round-trip)", async () => {
		const original = { user: { name: "ada", tags: ["z", "y"] }, n: 3, ok: true };
		const flat = (await run({ data: JSON.stringify(original) })).out;
		const back = (await run({ data: JSON.stringify(flat), direction: "unflatten" })).out;
		expect(back).toEqual(original);
	});

	it("honors a custom separator and preserves empty containers", async () => {
		const { out } = await run({ data: JSON.stringify({ a: { b: 1 }, e: {}, arr: [] }), sep: "/" });
		expect(out).toEqual({ "a/b": 1, e: {}, arr: [] });
	});
});
