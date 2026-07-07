import { afterEach, describe, expect, it, vi } from "vitest";

import { places } from "./places";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const RESULT = {
	places: [
		{
			displayName: { text: "Hardware Store", languageCode: "en" },
			formattedAddress: "123 Main St, Seattle, WA 98133",
			rating: 4.5,
			priceLevel: "PRICE_LEVEL_MODERATE",
			nationalPhoneNumber: "(206) 555-0100",
			websiteUri: "https://hardware.example",
			location: { latitude: 47.72, longitude: -122.34 },
		},
	],
};

const keyedEnv = () => ({ GOOGLE_MAPS_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("places", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await places.run({} as any, { query: "hardware store near 98133" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/GOOGLE_MAPS_KEY/);
	});

	it("normalizes places and sends the key + field mask + body", async () => {
		let init: any;
		global.fetch = vi.fn(async (_u: any, i: any) => {
			init = i;
			return json(RESULT);
		}) as any;
		const r = await places.run(keyedEnv(), { query: "hardware store near 98133", max_results: 5 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.results[0]).toMatchObject({
			name: "Hardware Store",
			address: "123 Main St, Seattle, WA 98133",
			rating: 4.5,
			price_level: "PRICE_LEVEL_MODERATE",
			phone: "(206) 555-0100",
			website: "https://hardware.example",
			lat: 47.72,
			lng: -122.34,
		});
		expect(init.headers["X-Goog-Api-Key"]).toBe("KEY");
		expect(init.headers["X-Goog-FieldMask"]).toContain("places.displayName");
		expect(JSON.parse(init.body)).toMatchObject({ textQuery: "hardware store near 98133", maxResultCount: 5 });
	});

	it("carries upstream HTTP status into the failure", async () => {
		global.fetch = vi.fn(async () => json({ error: {} }, 403)) as any;
		const r = await places.run(keyedEnv(), { query: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 403/);
	});
});
