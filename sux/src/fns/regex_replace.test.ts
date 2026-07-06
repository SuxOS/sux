import { describe, expect, it } from "vitest";
import { regex_replace } from "./regex_replace";

describe("regex_replace", () => {
	it("rejects a missing pattern", async () => {
		const r = await regex_replace.run({} as any, { text: "hello", pattern: "", replacement: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide a regex/);
	});

	it("replaces all matches with group references", async () => {
		const r = await regex_replace.run({} as any, {
			text: "2024-01-15",
			pattern: "(\\d{4})-(\\d{2})-(\\d{2})",
			replacement: "$3/$2/$1",
		});
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("15/01/2024");
	});

	it("honors custom flags (case-insensitive, first-only)", async () => {
		const r = await regex_replace.run({} as any, { text: "Foo foo FOO", pattern: "foo", replacement: "bar", flags: "i" });
		expect(r.content[0].text).toBe("bar foo FOO");
	});

	it("fails on an invalid regex", async () => {
		const r = await regex_replace.run({} as any, { text: "x", pattern: "(", replacement: "y" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Invalid regex/);
	});
});
