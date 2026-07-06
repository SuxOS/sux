import { describe, expect, it } from "vitest";
import { scrub_headers } from "./scrub_headers";

describe("scrub_headers", () => {
	it("rejects a non-object headers value", async () => {
		const r = await scrub_headers.run({} as any, { headers: "cookie: x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/must be an object/);
	});

	it("removes tracking/auth headers and keeps the rest", async () => {
		const r = await scrub_headers.run({} as any, {
			headers: {
				"Content-Type": "application/json",
				Cookie: "sid=abc",
				Authorization: "Bearer t",
				"User-Agent": "Mozilla",
				Accept: "*/*",
			},
		});
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.scrubbed["Content-Type"]).toBe("application/json");
		expect(out.scrubbed.Accept).toBe("*/*");
		expect(out.scrubbed.Cookie).toBeUndefined();
		expect(out.removed).toEqual(expect.arrayContaining(["Cookie", "Authorization", "User-Agent"]));
	});

	it("matches case-insensitively and by prefix (x-forwarded-*)", async () => {
		const r = await scrub_headers.run({} as any, {
			headers: { "X-Forwarded-For": "1.2.3.4", "x-forwarded-proto": "https", VIA: "1.1 proxy", Host: "example.com" },
		});
		const out = JSON.parse(r.content[0].text);
		expect(out.removed).toEqual(expect.arrayContaining(["X-Forwarded-For", "x-forwarded-proto", "VIA"]));
		expect(out.scrubbed.Host).toBe("example.com");
	});

	it("handles an empty headers object", async () => {
		const r = await scrub_headers.run({} as any, { headers: {} });
		const out = JSON.parse(r.content[0].text);
		expect(out.scrubbed).toEqual({});
		expect(out.removed).toEqual([]);
	});
});
