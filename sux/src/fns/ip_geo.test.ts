import { afterEach, describe, expect, it, vi } from "vitest";
import { ipGeo } from "./ip_geo";

afterEach(() => vi.unstubAllGlobals());

const okResp = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("ip_geo", () => {
	it("returns a flattened geolocation record", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				okResp({
					success: true,
					ip: "8.8.8.8",
					country: "United States",
					country_code: "US",
					region: "California",
					city: "Mountain View",
					latitude: 37.4,
					longitude: -122.07,
					connection: { asn: 15169, org: "Google LLC" },
					timezone: { id: "America/Los_Angeles" },
				}),
			),
		);
		const r = await ipGeo.run({} as any, { ip: "8.8.8.8" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.ip).toBe("8.8.8.8");
		expect(j.city).toBe("Mountain View");
		expect(j.asn).toBe(15169);
		expect(j.org).toBe("Google LLC");
		expect(j.timezone).toBe("America/Los_Angeles");
	});

	it("surfaces an unsuccessful lookup", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => okResp({ success: false, message: "reserved range" })));
		const r = await ipGeo.run({} as any, { ip: "0.0.0.0" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/reserved range/);
	});

	it("fails on a non-OK HTTP status", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
		const r = await ipGeo.run({} as any, { ip: "1.1.1.1" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 503/);
	});
});
