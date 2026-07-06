import { describe, expect, it } from "vitest";
import { sample } from "./sample";

const run = async (args: any) => sample.run({} as any, args);

describe("sample", () => {
	it("rejects a non-integer / negative n", async () => {
		expect((await run({ data: "a\nb", n: 1.5 })).isError).toBe(true);
		const neg = await run({ data: "a\nb", n: -1 });
		expect(neg.isError).toBe(true);
		expect(neg.content[0].text).toMatch(/non-negative integer/);
	});

	it("samples n lines, all drawn from the population", async () => {
		const pop = ["a", "b", "c", "d", "e"];
		const r = await run({ data: pop.join("\n"), n: 3 });
		expect(r.isError).toBeFalsy();
		const picked = r.content[0].text.split("\n");
		expect(picked).toHaveLength(3);
		expect(new Set(picked).size).toBe(3); // no duplicates
		for (const p of picked) expect(pop).toContain(p);
	});

	it("samples a JSON array and returns valid JSON", async () => {
		const arr = [1, 2, 3, 4];
		const r = await run({ data: JSON.stringify(arr), n: 2, mode: "json" });
		const out = JSON.parse(r.content[0].text);
		expect(Array.isArray(out)).toBe(true);
		expect(out).toHaveLength(2);
		for (const v of out) expect(arr).toContain(v);
	});

	it("returns the whole (shuffled) population when n >= length", async () => {
		const r = await run({ data: JSON.stringify([1, 2, 3]), n: 99, mode: "json" });
		const out = JSON.parse(r.content[0].text);
		expect([...out].sort()).toEqual([1, 2, 3]);
		const bad = await run({ data: "{oops", n: 1, mode: "json" });
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toMatch(/not valid JSON/);
	});
});
