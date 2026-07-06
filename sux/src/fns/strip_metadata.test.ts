import { describe, expect, it } from "vitest";
import { strip_metadata } from "./strip_metadata";

function b64(bytes: number[]): string {
	let s = "";
	for (const b of bytes) s += String.fromCharCode(b);
	return btoa(s);
}

// Minimal JPEG: SOI, APP1(Exif) segment, a keeper APP0/JFIF-ish, SOS + scan, EOI.
function jpegWithExif(): number[] {
	return [
		0xff, 0xd8, // SOI
		0xff, 0xe1, 0x00, 0x06, 0x45, 0x78, 0x69, 0x66, // APP1 len=6, "Exif" payload (drop)
		0xff, 0xdb, 0x00, 0x04, 0x11, 0x22, // DQT len=4 (keep)
		0xff, 0xda, 0x00, 0x03, 0x01, // SOS len=3 (keep)
		0xaa, 0xbb, 0xcc, // entropy-coded scan data (keep)
		0xff, 0xd9, // EOI
	];
}

// Minimal PNG: signature, IHDR, tEXt (drop), IDAT, IEND.
function pngWithText(): number[] {
	const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
	const chunk = (type: string, data: number[]) => {
		const len = data.length;
		const t = [...type].map((c) => c.charCodeAt(0));
		return [(len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff, ...t, ...data, 0, 0, 0, 0];
	};
	return [...sig, ...chunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]), ...chunk("tEXt", [65, 66]), ...chunk("IDAT", [1, 2, 3]), ...chunk("IEND", [])];
}

describe("strip_metadata", () => {
	it("rejects a non-image / bad input", async () => {
		const r = await strip_metadata.run({} as any, { image: "" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide an `image`/);
	});

	it("strips APP1(Exif) from a JPEG and keeps scan data", async () => {
		const r = await strip_metadata.run({} as any, { image: b64(jpegWithExif()) });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.format).toBe("jpeg");
		expect(out.removed).toContain("APP1(Exif/XMP)");
		expect(out.bytes).toBeLessThan(jpegWithExif().length);
		// Cleaned bytes must still start with SOI and end with EOI.
		const bin = atob(out.base64);
		expect(bin.charCodeAt(0)).toBe(0xff);
		expect(bin.charCodeAt(1)).toBe(0xd8);
		expect(bin.charCodeAt(bin.length - 2)).toBe(0xff);
		expect(bin.charCodeAt(bin.length - 1)).toBe(0xd9);
	});

	it("drops tEXt from a PNG and keeps IHDR/IDAT/IEND", async () => {
		const r = await strip_metadata.run({} as any, { image: b64(pngWithText()) });
		const out = JSON.parse(r.content[0].text);
		expect(out.format).toBe("png");
		expect(out.removed).toContain("tEXt");
		const bin = atob(out.base64);
		expect(bin).toContain("IHDR");
		expect(bin).toContain("IDAT");
		expect(bin).toContain("IEND");
		expect(bin).not.toContain("tEXt");
	});

	it("fails clearly on an unsupported format (PDF)", async () => {
		const r = await strip_metadata.run({} as any, { image: b64([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]) });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/PDF metadata stripping is planned/);
	});
});
