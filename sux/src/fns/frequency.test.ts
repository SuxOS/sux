import { describe, expect, it } from "vitest";
import { frequency } from "./frequency";

const freq = async (args: any) => JSON.parse((await frequency.run({} as any, args)).content[0].text);

describe("frequency", () => {
	it("rejects an unknown `by`", async () => {
		const r = await frequency.run({} as any, { text: "hi", by: "bogus" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/by must be one of/);
	});

	it("counts words case-insensitively, sorted by count desc", async () => {
		const out = await freq({ text: "The cat sat. The CAT ran. the dog." });
		expect(out[0]).toEqual({ item: "the", count: 3 });
		expect(out.find((e: any) => e.item === "cat")).toEqual({ item: "cat", count: 2 });
	});

	it("honors min_len and top", async () => {
		const out = await freq({ text: "a a bb bb bb ccc", by: "word", min_len: 2, top: 1 });
		expect(out).toHaveLength(1);
		expect(out[0]).toEqual({ item: "bb", count: 3 });
	});

	it("returns an empty array for empty text", async () => {
		const out = await freq({ text: "" });
		expect(out).toEqual([]);
	});
});
