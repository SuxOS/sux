import { describe, expect, it, vi } from "vitest";

// Mock the residential proxy so the test is offline & deterministic.
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(
		async () =>
			new Response("hello world", {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/plain", "x-test": "1" },
			}),
	),
}));

import { proxyFn } from "./proxy";

describe("proxy", () => {
	it("rejects non-http urls", async () => {
		const r = await proxyFn.run({} as any, { url: "ftp://x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("returns status, headers, bytes and text body", async () => {
		const r = await proxyFn.run({} as any, { url: "https://x.com" });
		const j = JSON.parse(r.content[0].text);
		expect(j.status).toBe(200);
		expect(j.bytes).toBe("hello world".length);
		expect(j.headers["x-test"]).toBe("1");
		expect(j.body).toBe("hello world");
	});

	it("as=base64 returns binary-safe bytes", async () => {
		const r = await proxyFn.run({} as any, { url: "https://x.com", as: "base64" });
		const j = JSON.parse(r.content[0].text);
		expect(atob(j.body)).toBe("hello world");
	});
});
