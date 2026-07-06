import { describe, expect, it } from "vitest";
import { mask } from "./mask";

describe("mask", () => {
	it("rejects a non-string value", async () => {
		const r = await mask.run({} as any, { value: 12345 as any });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/string `value`/);
	});

	it("reveals the last 4 by default", async () => {
		const r = await mask.run({} as any, { value: "4111111111111234" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("************1234");
	});

	it("honors show_start/show_end/char", async () => {
		const r = await mask.run({} as any, { value: "supersecret", show_start: 2, show_end: 2, char: "#" });
		expect(r.content[0].text).toBe("su#######et");
	});

	it("fully masks short values so nothing leaks", async () => {
		const r = await mask.run({} as any, { value: "123", show_end: 4 });
		expect(r.content[0].text).toBe("***");
	});
});
