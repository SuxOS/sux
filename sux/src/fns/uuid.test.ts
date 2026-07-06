import { describe, expect, it } from "vitest";

import { uuid } from "./uuid";

describe("uuid", () => {
	it("rejects an unknown kind", async () => {
		const r = await uuid.run({} as any, { kind: "bogus" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/kind must be/);
	});

	it("generates a single v4 uuid by default", async () => {
		const r = await uuid.run({} as any, {});
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
	});

	it("returns a JSON array of distinct ids when count>1", async () => {
		const r = await uuid.run({} as any, { count: 3 });
		const j = JSON.parse(r.content[0].text);
		expect(Array.isArray(j)).toBe(true);
		expect(j).toHaveLength(3);
		expect(new Set(j).size).toBe(3);
	});

	it("honors size for nanoid and hex", async () => {
		const nano = await uuid.run({} as any, { kind: "nanoid", size: 10 });
		expect(nano.content[0].text).toHaveLength(10);
		const hex = await uuid.run({} as any, { kind: "hex", size: 8 });
		expect(hex.content[0].text).toMatch(/^[0-9a-f]{16}$/);
	});
});
