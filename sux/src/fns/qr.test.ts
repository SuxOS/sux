import { afterEach, describe, expect, it, vi } from "vitest";

import { qr } from "./qr";

afterEach(() => vi.unstubAllGlobals());

describe("qr", () => {
	it("rejects encode with no data", async () => {
		const r = await qr.run({} as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `data`/);
	});

	it("encodes text into a base64 PNG", async () => {
		const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				expect(url).toContain("create-qr-code");
				expect(url).toContain("size=200x200");
				expect(url).toContain(`data=${encodeURIComponent("hello world")}`);
				return new Response(png, { status: 200 });
			}),
		);
		const r = await qr.run({} as any, { data: "hello world", size: 200 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.mime).toBe("image/png");
		expect(j.size).toBe(200);
		expect(j.base64).toBe(btoa(String.fromCharCode(...png)));
	});

	it("decodes a QR image from a url", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => {
				expect(url).toContain("read-qr-code");
				return new Response(JSON.stringify([{ symbol: [{ data: "decoded-text", error: null }] }]), { status: 200 });
			}),
		);
		const r = await qr.run({} as any, { direction: "decode", image: "https://example.com/qr.png" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("decoded-text");
	});

	it("reports when no QR is found in the image", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ symbol: [{ data: null, error: "No barcode found" }] }]), { status: 200 })));
		const r = await qr.run({} as any, { direction: "decode", image: "https://example.com/blank.png" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/No QR found: No barcode found/);
	});
});
