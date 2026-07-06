import { afterEach, describe, expect, it, vi } from "vitest";
import { tlsInfo } from "./tls_info";

afterEach(() => vi.unstubAllGlobals());

const CERTS = [
	{ issuer_name: "C=US, O=Let's Encrypt, CN=R3", not_before: "2024-01-01T00:00:00", not_after: "2024-04-01T00:00:00", name_value: "example.com\nwww.example.com" },
	{ issuer_name: "C=US, O=Let's Encrypt, CN=R3", not_before: "2024-06-01T00:00:00", not_after: "2024-09-01T00:00:00", name_value: "example.com" },
	// duplicate of the first row — should be de-duped
	{ issuer_name: "C=US, O=Let's Encrypt, CN=R3", not_before: "2024-01-01T00:00:00", not_after: "2024-04-01T00:00:00", name_value: "example.com\nwww.example.com" },
];

describe("tls_info", () => {
	it("returns recent certs newest-first and de-duplicated", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(CERTS), { status: 200 })));
		const r = await tlsInfo.run({} as any, { host: "example.com" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.length).toBe(2); // duplicate collapsed
		expect(out[0].not_before).toBe("2024-06-01T00:00:00"); // newest first
		expect(out[0].names).toEqual(["example.com"]);
		expect(out[1].names).toEqual(["example.com", "www.example.com"]);
	});

	it("rejects an empty host", async () => {
		const r = await tlsInfo.run({} as any, { host: "" });
		expect(r.isError).toBe(true);
	});

	it("reports empty CT results cleanly", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
		const r = await tlsInfo.run({} as any, { host: "no-certs.example" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/no CT log entries/);
	});
});
