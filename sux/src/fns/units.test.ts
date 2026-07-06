import { describe, expect, it } from "vitest";
import { units } from "./units";

const run = async (args: any) => {
	const r = await units.run({} as any, args);
	return { r, out: r.isError ? null : JSON.parse(r.content[0].text) };
};

describe("units", () => {
	it("converts length (km → mi) and mass (kg → lb)", async () => {
		const km = (await run({ value: 5, from: "km", to: "mi" })).out;
		expect(km.result).toBeCloseTo(3.10686, 4);
		const kg = (await run({ value: 10, from: "kg", to: "lb" })).out;
		expect(kg.result).toBeCloseTo(22.0462, 3);
	});

	it("handles temperature affinely (C ↔ F, K)", async () => {
		expect((await run({ value: 100, from: "C", to: "F" })).out.result).toBeCloseTo(212, 6);
		expect((await run({ value: 0, from: "C", to: "K" })).out.result).toBeCloseTo(273.15, 6);
		expect((await run({ value: 32, from: "fahrenheit", to: "celsius" })).out.result).toBeCloseTo(0, 6);
	});

	it("distinguishes decimal vs binary data units", async () => {
		expect((await run({ value: 1, from: "GiB", to: "MiB" })).out.result).toBe(1024);
		expect((await run({ value: 1, from: "GB", to: "MB" })).out.result).toBe(1000);
	});

	it("fails on incompatible dimensions and unknown units", async () => {
		const incompat = await run({ value: 1, from: "km", to: "kg" });
		expect(incompat.r.isError).toBe(true);
		expect(incompat.r.content[0].text).toMatch(/[Ii]ncompatible/);
		expect((await run({ value: 1, from: "smoots", to: "m" })).r.isError).toBe(true);
	});
});
