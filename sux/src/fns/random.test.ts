import { describe, expect, it } from "vitest";

import { fromB64 } from "./_util";
import { random } from "./random";

describe("random", () => {
	it("rejects an unknown kind", async () => {
		const r = await random.run({} as any, { kind: "bogus" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/kind must be/);
	});

	it("returns an int within the inclusive range", async () => {
		for (let i = 0; i < 200; i++) {
			const r = await random.run({} as any, { kind: "int", min: 5, max: 7 });
			expect(r.isError).toBeFalsy();
			const n = Number(r.content[0].text);
			expect(Number.isInteger(n)).toBe(true);
			expect(n).toBeGreaterThanOrEqual(5);
			expect(n).toBeLessThanOrEqual(7);
		}
	});

	it("draws a string only from the supplied alphabet and honors length", async () => {
		const r = await random.run({} as any, { kind: "string", length: 32, alphabet: "ab" });
		expect(r.content[0].text).toHaveLength(32);
		expect(r.content[0].text).toMatch(/^[ab]{32}$/);
	});

	it("returns base64 bytes of the requested length and rejects max<min", async () => {
		const r = await random.run({} as any, { kind: "bytes", length: 12 });
		expect(fromB64(r.content[0].text)).toHaveLength(12);
		const bad = await random.run({} as any, { kind: "int", min: 10, max: 1 });
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toMatch(/max must be >= min/);
	});
});
