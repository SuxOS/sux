import { afterEach, describe, expect, it, vi } from "vitest";

import { dns } from "./dns";

afterEach(() => vi.unstubAllGlobals());

describe("dns", () => {
	it("rejects an unknown record type", async () => {
		const r = await dns.run({} as any, { name: "example.com", type: "BOGUS" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/type must be one of/);
	});

	it("resolves A records via DoH", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				expect(url).toContain("name=example.com");
				expect(url).toContain("type=A");
				return new Response(JSON.stringify({ Status: 0, Answer: [{ name: "example.com", type: 1, TTL: 300, data: "93.184.216.34" }] }), { status: 200 });
			}),
		);
		const r = await dns.run({} as any, { name: "example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("93.184.216.34");
		expect(r.content[0].text).toContain("300");
	});

	it("reports when there are no answer records", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Status: 0, Answer: [] }), { status: 200 })));
		const r = await dns.run({} as any, { name: "nothing.example", type: "MX" });
		expect(r.content[0].text).toMatch(/no MX records/);
	});

	it("surfaces a failed DoH query", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 502 })));
		const r = await dns.run({} as any, { name: "example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 502/);
	});
});
