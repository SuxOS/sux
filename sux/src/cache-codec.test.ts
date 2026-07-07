import { describe, expect, it } from "vitest";
import { packForCache, unpackFromCache } from "./cache-codec";

describe("cache-codec", () => {
	it("passes small payloads through as a plain string (frame not worth it)", () => {
		const s = JSON.stringify({ a: 1 });
		expect(packForCache(s)).toBe(s);
		expect(unpackFromCache(s)).toBe(s);
	});

	it("compresses a large JSON payload to a tagged byte frame and round-trips it", () => {
		const big = JSON.stringify({ content: [{ type: "text", text: "lorem ipsum dolor ".repeat(200) }] });
		const packed = packForCache(big);
		expect(typeof packed).not.toBe("string");
		const bytes = packed as Uint8Array;
		expect([...bytes.slice(0, 4)]).toEqual([0x73, 0x78, 0x7a, 0x31]);
		expect([0x7a, 0x62, 0x67]).toContain(bytes[4]);
		expect(bytes.length).toBeLessThan(new TextEncoder().encode(big).length);
		expect(unpackFromCache(bytes)).toBe(big);
		expect(unpackFromCache(bytes.buffer.slice(0) as ArrayBuffer)).toBe(big);
	});

	it("decodes a legacy / plain-JSON entry (no magic) whether string or bytes", () => {
		const legacy = JSON.stringify({ old: true, note: "x".repeat(1000) });
		expect(unpackFromCache(legacy)).toBe(legacy);
		expect(unpackFromCache(new TextEncoder().encode(legacy))).toBe(legacy);
	});

	it("returns the plain string when compression wouldn't shrink it", () => {

		const s = JSON.stringify({ r: Array.from({ length: 600 }, (_, i) => String.fromCharCode(33 + (i % 90))).join("") });
		const packed = packForCache(s);

		expect(unpackFromCache(packed as any)).toBe(s);
	});
});
