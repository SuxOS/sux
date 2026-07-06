import { describe, expect, it } from "vitest";
import { datetime } from "./datetime";

const run = async (args: any) => {
	const r = await datetime.run({} as any, args);
	return { r, out: r.isError ? null : JSON.parse(r.content[0].text) };
};

describe("datetime", () => {
	it("parses an ISO string into UTC components", async () => {
		const out = (await run({ input: "2024-01-15T08:30:00Z" })).out;
		expect(out.epoch_ms).toBe(Date.parse("2024-01-15T08:30:00Z"));
		expect(out.utc).toMatchObject({ year: 2024, month: 1, day: 15, hour: 8, minute: 30, weekday: "Monday" });
	});

	it("parses epoch seconds and milliseconds", async () => {
		const sec = (await run({ input: 1705305600 })).out; // 2024-01-15T08:00:00Z
		expect(sec.iso).toBe("2024-01-15T08:00:00.000Z");
		const ms = (await run({ input: "1705305600000" })).out;
		expect(ms.iso).toBe("2024-01-15T08:00:00.000Z");
	});

	it("applies a shift and reports both blocks", async () => {
		const out = (await run({ input: "2024-01-15T00:00:00Z", add: "+3d" })).out;
		expect(out.shifted.iso).toBe("2024-01-18T00:00:00.000Z");
		const back = (await run({ input: "2024-01-15T12:00:00Z", add: "-2h" })).out;
		expect(back.shifted.iso).toBe("2024-01-15T10:00:00.000Z");
	});

	it("fails on unparseable input and bad shift", async () => {
		expect((await run({ input: "not a date" })).r.isError).toBe(true);
		expect((await run({ input: "2024-01-15", add: "soon" })).r.isError).toBe(true);
	});
});
