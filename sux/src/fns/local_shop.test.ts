import { afterEach, describe, expect, it, vi } from "vitest";

import { smartFetch } from "../proxy";

vi.mock("../proxy", () => ({ smartFetch: vi.fn() }));

import { localShop } from "./local_shop";

const env = { KAGI_API_KEY: "k" } as any;

// Build a Kagi MCP JSON-RPC response whose tool result text is `md`.
const rpcResponse = (md: string, isError = false) =>
	new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { content: [{ type: "text", text: md }], ...(isError ? { isError: true } : {}) },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

afterEach(() => vi.clearAllMocks());

describe("kagi_local_shop", () => {
	it("rejects when product/location are missing", async () => {
		const r = await localShop.run(env, { product: "" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/required/i);
		expect(smartFetch).not.toHaveBeenCalled();
	});

	it("returns a price-ranked table for store listings", async () => {
		const md = [
			"### [Cheap Mixer](https://shopa.com/mixer)",
			"KitchenAid stand mixer, in stock, $199.99 today",
			"",
			"### [Pricey Mixer](https://shopb.com/mixer)",
			"KitchenAid stand mixer available for $349.00",
		].join("\n");
		vi.mocked(smartFetch).mockResolvedValue(rpcResponse(md));

		const r = await localShop.run(env, { product: "KitchenAid stand mixer", location: "Austin, TX" });
		expect(r.isError).toBeFalsy();
		const text = r.content[0].text;
		expect(text).toContain("shopa.com");
		expect(text).toContain("$199.99");
		expect(text).toContain("shopb.com");
		// Cheapest listing ranked first.
		expect(text.indexOf("shopa.com")).toBeLessThan(text.indexOf("shopb.com"));
		expect(text).toContain("2 with a parsed price");
	});

	it("collapses duplicate hosts to their cheapest listing", async () => {
		const md = [
			"### [Mixer expensive](https://store.com/a)",
			"stand mixer $500.00 in stock",
			"",
			"### [Mixer cheap](https://store.com/b)",
			"stand mixer $250.00 in stock",
		].join("\n");
		vi.mocked(smartFetch).mockResolvedValue(rpcResponse(md));

		const r = await localShop.run(env, { product: "mixer", location: "Reno, NV" });
		const text = r.content[0].text;
		expect(text).toContain("1 listings");
		expect(text).toContain("$250.00");
		expect(text).not.toContain("$500.00");
	});

	it("errors when the search yields no store listings", async () => {
		vi.mocked(smartFetch).mockResolvedValue(rpcResponse("No results here, just prose."));
		const r = await localShop.run(env, { product: "mixer", location: "Austin, TX" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/No store listings found/);
	});
});
