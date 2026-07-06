import { afterEach, describe, expect, it, vi } from "vitest";

import { redirects } from "./redirects";

afterEach(() => vi.unstubAllGlobals());

describe("redirects", () => {
	it("rejects non-http urls", async () => {
		const r = await redirects.run({} as any, { url: "ftp://x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("follows the redirect chain to the final destination", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				if (url === "http://a.com/") return new Response(null, { status: 301, headers: { location: "https://b.com/final" } });
				return new Response(null, { status: 200 });
			}),
		);
		const r = await redirects.run({} as any, { url: "http://a.com/" });
		const j = JSON.parse(r.content[0].text);
		expect(j.hops).toBe(2);
		expect(j.chain[0].status).toBe(301);
		expect(j.chain[0].location).toBe("https://b.com/final");
		expect(j.final).toBe("https://b.com/final");
	});

	it("reports a fetch failure with the offending url", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("boom");
			}),
		);
		const r = await redirects.run({} as any, { url: "https://x.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Fetch failed/);
	});
});
