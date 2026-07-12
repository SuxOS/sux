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

import { smartFetch } from "../proxy";
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

	it("marks upstream error pages noCache (they must not poison the cache)", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
		const r = await proxyFn.run({} as any, { url: "https://x.com/hot" });
		expect(r.isError).toBeFalsy(); // raw transport still returns the body
		expect(r.noCache).toBe(true);
		// 2xx responses stay cacheable.
		const good = await proxyFn.run({} as any, { url: "https://x.com" });
		expect(good.noCache).toBeUndefined();
	});

	it("marks non-idempotent methods noCache (a mutating POST must never be memoized)", async () => {
		const post = await proxyFn.run({} as any, { url: "https://x.com/mutate", method: "POST", body: "x" });
		expect(post.isError).toBeFalsy();
		expect(post.noCache).toBe(true);
		const del = await proxyFn.run({} as any, { url: "https://x.com/mutate", method: "delete" });
		expect(del.noCache).toBe(true);
		// GET/HEAD stay cacheable.
		const get = await proxyFn.run({} as any, { url: "https://x.com", method: "GET" });
		expect(get.noCache).toBeUndefined();
		const head = await proxyFn.run({} as any, { url: "https://x.com", method: "HEAD" });
		expect(head.noCache).toBeUndefined();
	});

	it("forwards an x-exit-geo header to the residential exit", async () => {
		const mock = vi.mocked(smartFetch);
		mock.mockClear();
		await proxyFn.run({} as any, { url: "https://x.com", headers: { "x-exit-geo": "us-ca" } });
		const passedInit = mock.mock.calls[0][2] as { headers?: Record<string, string> };
		expect(passedInit.headers?.["x-exit-geo"]).toBe("us-ca");
	});

	it("streams and aborts past max_bytes rather than buffering the whole body", async () => {
		// A body larger than max_bytes: readBodyBytes cancels the stream and throws, so
		// the huge/hostile response is never fully materialized (the OOM the old
		// resp.arrayBuffer() path risked).
		let cancelled = false;
		let pulls = 0;
		const stream = new ReadableStream({
			pull(controller) {
				if (pulls++ < 50) controller.enqueue(new TextEncoder().encode("x".repeat(1000)));
				else controller.close();
			},
			cancel() {
				cancelled = true;
			},
		});
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response(stream, { status: 200 }));
		const r = await proxyFn.run({} as any, { url: "https://x.com/big", max_bytes: 10 });
		expect(r.isError).toBe(true);
		expect(r.errorCode).toBe("upstream_error");
		expect(cancelled).toBe(true); // stream aborted, never fully materialized
	});
});
