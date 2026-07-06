import { describe, expect, it } from "vitest";
import { checksum } from "./checksum";

const run = async (args: any) => checksum.run({} as any, args);

describe("checksum", () => {
	it("rejects an unknown algorithm", async () => {
		const r = await run({ text: "hi", algo: "md5" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Unknown algo/);
	});

	it("computes the canonical crc32 check value", async () => {
		// "123456789" is the standard CRC-32 test vector.
		const r = await run({ text: "123456789" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("cbf43926");
	});

	it("computes adler32 (Wikipedia reference vector)", async () => {
		const r = await run({ text: "Wikipedia", algo: "adler32" });
		expect(r.content[0].text).toBe("11e60398");
	});

	it("handles empty input and always pads to 8 hex digits", async () => {
		expect((await run({ text: "" })).content[0].text).toBe("00000000");
		expect((await run({ text: "", algo: "adler32" })).content[0].text).toBe("00000001");
	});
});
