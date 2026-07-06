import { describe, expect, it } from "vitest";
import { entities } from "./entities";

const parse = async (text: string) => JSON.parse((await entities.run({} as any, { text })).content[0].text);

describe("entities", () => {
	it("extracts mixed entity types", async () => {
		const out = await parse(
			"Reach me at jane.doe@example.com or visit https://example.com/path. Paid $1,234.56 on 2024-01-15, up 12.5%. Ping @jane #launch. Call +1 415-555-0198.",
		);
		expect(out.emails).toContain("jane.doe@example.com");
		expect(out.urls).toContain("https://example.com/path");
		expect(out.money).toContain("$1,234.56");
		expect(out.dates).toContain("2024-01-15");
		expect(out.percentages).toContain("12.5%");
		expect(out.handles).toContain("@jane");
		expect(out.hashtags).toContain("#launch");
		expect(out.phones.length).toBeGreaterThan(0);
	});

	it("dedupes case-insensitively and does not treat email @ as a handle", async () => {
		const out = await parse("Mail A@Test.com and a@test.com — both same. #Tag and #tag too.");
		expect(out.emails).toHaveLength(1);
		expect(out.handles).toHaveLength(0);
		expect(out.hashtags).toHaveLength(1);
	});

	it("fails on empty text", async () => {
		const r = await entities.run({} as any, { text: "   " });
		expect(r.isError).toBe(true);
	});
});
