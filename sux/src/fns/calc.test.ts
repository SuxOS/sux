import { describe, expect, it } from "vitest";
import { calc } from "./calc";

const run = async (expr: string) => {
	const r = await calc.run({} as any, { expr });
	return { r, out: r.isError ? null : JSON.parse(r.content[0].text) };
};

describe("calc", () => {
	it("respects precedence, parentheses and exponent right-assoc", async () => {
		expect((await run("2 + 3 * 4")).out.result).toBe(14);
		expect((await run("(2 + 3) * 4")).out.result).toBe(20);
		expect((await run("2 ^ 3 ^ 2")).out.result).toBe(512); // 2^(3^2)
	});

	it("handles unary minus, functions and constants", async () => {
		expect((await run("-5 + 3")).out.result).toBe(-2);
		expect((await run("sqrt(16)")).out.result).toBe(4);
		expect((await run("max(sqrt(16), 3)")).out.result).toBe(4);
		expect((await run("round(pi * 100) / 100")).out.result).toBe(3.14);
	});

	it("errors on division by zero and syntax errors", async () => {
		expect((await run("1 / 0")).r.isError).toBe(true);
		expect((await run("2 +")).r.isError).toBe(true);
		expect((await run("2 ** 3")).r.isError).toBe(true); // no ** operator
		expect((await run("foobar(2)")).r.isError).toBe(true);
	});
});
