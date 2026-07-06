import { describe, expect, it } from "vitest";
import { baseConvert } from "./base_convert";

const run = async (args: any) => {
	const r = await baseConvert.run({} as any, args);
	return { r, out: r.isError ? null : JSON.parse(r.content[0].text) };
};

describe("base_convert", () => {
	it("rejects out-of-range bases and invalid digits", async () => {
		expect((await run({ value: "10", from_base: 1, to_base: 10 })).r.isError).toBe(true);
		expect((await run({ value: "10", from_base: 10, to_base: 37 })).r.isError).toBe(true);
		const badDigit = await run({ value: "1g", from_base: 16, to_base: 10 });
		expect(badDigit.r.isError).toBe(true);
		expect(badDigit.r.content[0].text).toMatch(/not a valid base-16 digit/);
	});

	it("converts hex to decimal and binary to hex", async () => {
		expect((await run({ value: "ff", from_base: 16, to_base: 10 })).out.result).toBe("255");
		expect((await run({ value: "1010", from_base: 2, to_base: 16 })).out.result).toBe("a");
	});

	it("handles big values via BigInt and negatives", async () => {
		const big = "ffffffffffffffffffffffff"; // way past Number.MAX_SAFE_INTEGER
		expect((await run({ value: big, from_base: 16, to_base: 10 })).out.result).toBe(
			(BigInt("0x" + big)).toString(10),
		);
		expect((await run({ value: "-1010", from_base: 2, to_base: 10 })).out.result).toBe("-10");
	});

	it("normalizes zero (no negative zero) and empty input", async () => {
		expect((await run({ value: "-0", from_base: 10, to_base: 2 })).out.result).toBe("0");
		const empty = await run({ value: "   ", from_base: 10, to_base: 2 });
		expect(empty.r.isError).toBe(true);
	});
});
