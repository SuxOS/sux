import { afterEach, describe, expect, it, vi } from "vitest";
import { whois } from "./whois";

afterEach(() => vi.unstubAllGlobals());

const RDAP = {
	ldhName: "example.com",
	status: ["client transfer prohibited"],
	events: [
		{ eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" },
		{ eventAction: "expiration", eventDate: "2026-08-13T04:00:00Z" },
		{ eventAction: "lastChanged", eventDate: "2024-08-14T07:01:44Z" },
	],
	entities: [
		{
			roles: ["registrar"],
			handle: "376",
			vcardArray: ["vcard", [["fn", {}, "text", "RESERVED-Internet Assigned Numbers Authority"]]],
		},
	],
	nameservers: [{ ldhName: "A.IANA-SERVERS.NET" }, { ldhName: "B.IANA-SERVERS.NET" }],
};

describe("whois", () => {
	it("summarizes an RDAP record", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(RDAP), { status: 200 })));
		const r = await whois.run({} as any, { domain: "example.com" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.domain).toBe("example.com");
		expect(j.registrar).toBe("RESERVED-Internet Assigned Numbers Authority");
		expect(j.registered).toBe("1995-08-14T04:00:00Z");
		expect(j.expires).toBe("2026-08-13T04:00:00Z");
		expect(j.nameservers).toEqual(["A.IANA-SERVERS.NET", "B.IANA-SERVERS.NET"]);
	});

	it("rejects an empty domain", async () => {
		const r = await whois.run({} as any, { domain: "   " });
		expect(r.isError).toBe(true);
	});

	it("reports a missing record on 404", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
		const r = await whois.run({} as any, { domain: "no-such-domain-xyz.example" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/no RDAP record/);
	});
});
