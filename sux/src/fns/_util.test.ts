import { describe, expect, it } from "vitest";
import { clamp, fromB64, isHttpUrl, stripHtml, toB64 } from "./_util";

describe("_util", () => {
	it("isHttpUrl", () => {
		expect(isHttpUrl("https://x.com")).toBe(true);
		expect(isHttpUrl("ftp://x")).toBe(false);
		expect(isHttpUrl(42)).toBe(false);
	});

	it("clamp marks truncation", () => {
		expect(clamp("abc", 10)).toBe("abc");
		expect(clamp("abcdef", 3)).toMatch(/^abc\n… \[truncated/);
	});

	it("base64 round-trips arbitrary bytes", () => {
		const bytes = new Uint8Array([0, 1, 2, 250, 255, 128]);
		expect([...fromB64(toB64(bytes))]).toEqual([...bytes]);
	});

	it("stripHtml removes tags and decodes entities", () => {
		expect(stripHtml("<p>a &amp; <b>b</b></p><script>x()</script>")).toBe("a & b");
	});
});
