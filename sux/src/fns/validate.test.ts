import { describe, expect, it } from "vitest";
import { validate } from "./validate";

const run = async (args: any) => {
	const r = await validate.run({} as any, args);
	return { r, out: r.isError ? null : JSON.parse(r.content[0].text) };
};

describe("validate", () => {
	it("validates named formats (email, uuid, ipv4, credit_card, gtin)", async () => {
		expect((await run({ data: "a@b.com", format: "email" })).out.valid).toBe(true);
		expect((await run({ data: "nope", format: "email" })).out.valid).toBe(false);
		expect((await run({ data: "123e4567-e89b-12d3-a456-426614174000", format: "uuid" })).out.valid).toBe(true);
		expect((await run({ data: "10.0.0.1", format: "ipv4" })).out.valid).toBe(true);
		expect((await run({ data: "256.0.0.1", format: "ipv4" })).out.valid).toBe(false);
		expect((await run({ data: "4111111111111111", format: "credit_card" })).out.valid).toBe(true);
		expect((await run({ data: "4111111111111112", format: "credit_card" })).out.valid).toBe(false);
		// UPC-A for a real product check digit.
		expect((await run({ data: "036000291452", format: "gtin" })).out.valid).toBe(true);
		expect((await run({ data: "036000291453", format: "gtin" })).out.valid).toBe(false);
	});

	it("validates json and iso_date and ipv6", async () => {
		expect((await run({ data: '{"a":1}', format: "json" })).out.valid).toBe(true);
		expect((await run({ data: "{bad", format: "json" })).out.valid).toBe(false);
		expect((await run({ data: "2024-01-15", format: "iso_date" })).out.valid).toBe(true);
		expect((await run({ data: "2001:db8::1", format: "ipv6" })).out.valid).toBe(true);
	});

	it("validates against a minimal schema", async () => {
		const schema = { type: "object", required: ["name", "age"], properties: { name: { type: "string" }, age: { type: "number" } } };
		const good = (await run({ data: JSON.stringify({ name: "Jo", age: 3 }), schema })).out;
		expect(good.valid).toBe(true);
		const bad = (await run({ data: JSON.stringify({ name: 5 }), schema })).out;
		expect(bad.valid).toBe(false);
		expect(bad.errors.join(" ")).toMatch(/age/);
		expect(bad.errors.join(" ")).toMatch(/name/);
	});

	it("fails when neither or both of format/schema are given", async () => {
		expect((await run({ data: "x" })).r.isError).toBe(true);
		expect((await run({ data: "x", format: "email", schema: {} })).r.isError).toBe(true);
		expect((await run({ data: "x", format: "bogus" })).r.isError).toBe(true);
	});
});
