import { describe, expect, it, vi } from "vitest";

// Mock the residential proxy so the test is offline & deterministic.
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(
		async () =>
			new Response(null, {
				status: 200,
				statusText: "OK",
				headers: { "content-type": "text/html", "cache-control": "max-age=60" },
			}),
	),
}));

import { headers } from "./headers";

describe("headers", () => {
	it("rejects non-http urls", async () => {
		const r = await headers.run({} as any, { url: "ftp://x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("returns status, latency and response headers", async () => {
		const r = await headers.run({} as any, { url: "https://x.com" });
		const j = JSON.parse(r.content[0].text);
		expect(j.status).toBe(200);
		expect(j.statusText).toBe("OK");
		expect(typeof j.latency_ms).toBe("number");
		expect(j.headers["content-type"]).toBe("text/html");
	});
});
