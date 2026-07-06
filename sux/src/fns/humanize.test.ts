import { describe, expect, it } from "vitest";
import { humanize } from "./humanize";

const run = (args: any) => humanize.run({} as any, args);

describe("humanize", () => {
	it("rejects a non-finite value and an unknown kind", async () => {
		expect((await run({ value: Number.NaN, kind: "number" })).isError).toBe(true);
		const bad = await run({ value: 1, kind: "bogus" });
		expect(bad.isError).toBe(true);
		expect(bad.content[0].text).toMatch(/kind must be one of/);
	});

	it("formats bytes in decimal (default) and binary base", async () => {
		expect((await run({ value: 1500, kind: "bytes" })).content[0].text).toBe("1.5 KB");
		expect((await run({ value: 1048576, kind: "bytes", base: 1024 })).content[0].text).toBe("1 MiB");
		expect((await run({ value: 512, kind: "bytes" })).content[0].text).toBe("512 B");
	});

	it("formats durations, grouped numbers and percentages", async () => {
		expect((await run({ value: 3720000, kind: "duration_ms" })).content[0].text).toBe("1h 2m");
		expect((await run({ value: 500, kind: "duration_ms" })).content[0].text).toBe("500ms");
		expect((await run({ value: 1234567, kind: "number" })).content[0].text).toBe("1,234,567");
		expect((await run({ value: 0.1234, kind: "percent" })).content[0].text).toBe("12.34%");
	});

	it("handles the zero/small edge cases", async () => {
		expect((await run({ value: 0, kind: "bytes" })).content[0].text).toBe("0 B");
		expect((await run({ value: 0, kind: "duration_ms" })).content[0].text).toBe("0ms");
		expect((await run({ value: -2048, kind: "bytes", base: 1024 })).content[0].text).toBe("-2 KiB");
	});
});
