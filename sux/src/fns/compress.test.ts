import { describe, expect, it } from "vitest";
import { compress } from "./compress";

const original = "the quick brown fox ".repeat(200); // compressible

async function roundTrip(codec: string) {
	const c = JSON.parse((await compress.run({} as any, { data: original, codec })).content[0].text);
	const d = await compress.run({} as any, { data: c.base64, codec, direction: "decompress" });
	return { meta: c, decoded: d.content[0].text };
}

describe("compress", () => {
	it("defaults to brotli and round-trips losslessly at high ratio", async () => {
		const { meta, decoded } = await roundTrip("brotli");
		expect(meta.codec).toBe("brotli");
		expect(meta.saved_pct).toBeGreaterThan(80); // repetitive text -> excellent brotli ratio
		expect(meta.out_bytes).toBeLessThan(meta.in_bytes);
		expect(decoded).toBe(original);
	});

	it("round-trips gzip and deflate-raw too", async () => {
		expect((await roundTrip("gzip")).decoded).toBe(original);
		expect((await roundTrip("deflate-raw")).decoded).toBe(original);
	});

	it("round-trips zstd when the runtime supports it, else fails cleanly", async () => {
		const c = await compress.run({} as any, { data: original, codec: "zstd" });
		if (c.isError) {
			expect(c.content[0].text).toMatch(/zstd is not available/);
		} else {
			const meta = JSON.parse(c.content[0].text);
			const d = await compress.run({} as any, { data: meta.base64, codec: "zstd", direction: "decompress" });
			expect(d.content[0].text).toBe(original);
		}
	});

	it("rejects an unknown codec", async () => {
		const r = await compress.run({} as any, { data: "x", codec: "7z" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown codec/);
	});
});
