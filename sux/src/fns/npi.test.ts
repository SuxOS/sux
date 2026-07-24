import { afterEach, describe, expect, it, vi } from "vitest";
import { npi } from "./npi";

const BODY = {
	result_count: 1,
	results: [
		{
			number: "1234567890",
			enumeration_type: "NPI-1",
			basic: { first_name: "Jane", last_name: "Doe", status: "A" },
			addresses: [{ address_purpose: "LOCATION", city: "Boston", state: "MA", postal_code: "02110", telephone_number: "555-1212" }],
			taxonomies: [{ desc: "Pediatrics", primary: true }],
		},
	],
};

afterEach(() => vi.restoreAllMocks());

describe("npi", () => {
	it("normalizes results into { npi, type, name, status, specialty, city, state, postal_code, phone }", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await npi.run({} as any, { last_name: "Doe" });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		const e = out.results[0];
		expect(e.npi).toBe("1234567890");
		expect(e.type).toBe("individual");
		expect(e.name).toBe("Jane Doe");
		expect(e.specialty).toBe("Pediatrics");
		expect(e.city).toBe("Boston");
		expect(e.state).toBe("MA");
	});

	it("errors without any search field", async () => {
		const r = await npi.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 500 }));
		const r = await npi.run({} as any, { number: "1234567890" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/500/);
	});
});
