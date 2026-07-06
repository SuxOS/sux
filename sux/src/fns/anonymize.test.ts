import { describe, expect, it } from "vitest";
import { anonymize } from "./anonymize";

describe("anonymize", () => {
	it("rejects an unknown type", async () => {
		const r = await anonymize.run({} as any, { text: "hi", types: ["ssn"] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown type/);
	});

	it("assigns stable tokens per unique value", async () => {
		const text = "mail a@x.com and a@x.com, also b@y.org from 10.0.0.1";
		const r = await anonymize.run({} as any, { text });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		// Same email → same token both times.
		expect(out.anonymized).toContain("<email_1>");
		expect(out.anonymized).toContain("<email_2>");
		expect(out.anonymized.match(/<email_1>/g)?.length).toBe(2);
		expect(out.anonymized).toContain("<ip_1>");
		expect(out.mapping["<email_1>"]).toBe("a@x.com");
		expect(out.mapping["<ip_1>"]).toBe("10.0.0.1");
	});

	it("respects the types subset (only emails)", async () => {
		const r = await anonymize.run({} as any, { text: "a@x.com and 10.0.0.1", types: ["email"] });
		const out = JSON.parse(r.content[0].text);
		expect(out.anonymized).toContain("<email_1>");
		expect(out.anonymized).toContain("10.0.0.1"); // ip untouched
		expect(Object.keys(out.mapping)).toEqual(["<email_1>"]);
	});

	it("rejects empty text", async () => {
		const r = await anonymize.run({} as any, { text: "" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/non-empty/);
	});
});
