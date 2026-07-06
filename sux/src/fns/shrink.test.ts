import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("<html><body><p>Hello   world</p></body></html>", { status: 200 })),
}));

import { shrink } from "./shrink";
import { smartFetch } from "../proxy";

afterEach(() => vi.clearAllMocks());

describe("shrink", () => {
	it("rejects a non-token kind that needs WASM", async () => {
		const r = await shrink.run({} as any, { source: "hello", kind: "pdf" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/needs WASM/);
	});

	it("strips markup and collapses whitespace, reporting token delta", async () => {
		const r = await shrink.run({} as any, { source: "<div>Hello     world</div>\n\n\n\nHello     world" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.text).not.toContain("<div>");
		expect(out.text).not.toContain("     ");
		expect(out.out_tokens).toBeLessThanOrEqual(out.in_tokens);
		expect(typeof out.saved_pct).toBe("number");
	});

	it("fetches an http(s) source and truncates to the target token cap", async () => {
		const r = await shrink.run({} as any, { source: "https://example.com/page", target: 1 });
		expect(smartFetch).toHaveBeenCalledOnce();
		const out = JSON.parse(r.content[0].text);
		expect(out.truncated).toBe(true);
		expect(out.text.length).toBeLessThanOrEqual(4);
	});

	it("fails when source is empty", async () => {
		const r = await shrink.run({} as any, { source: "" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `source`/);
	});
});
