import { describe, expect, it } from "vitest";
import { word_count } from "./word_count";

const stats = async (text: string) => JSON.parse((await word_count.run({} as any, { text })).content[0].text);

describe("word_count", () => {
	it("rejects a non-string text", async () => {
		const r = await word_count.run({} as any, { text: 123 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `text`/);
	});

	it("counts chars, words, lines and sentences on the happy path", async () => {
		const out = await stats("Hello world. This is a test!\nSecond line here.");
		expect(out.words).toBe(9);
		expect(out.lines).toBe(2);
		expect(out.sentences).toBe(3);
		expect(out.chars).toBe("Hello world. This is a test!\nSecond line here.".length);
		expect(out.chars_no_spaces).toBe(38);
	});

	it("rounds reading time up and handles unicode by code point", async () => {
		// 201 words -> ceil(201/200) = 2 minutes.
		const out = await stats(Array(201).fill("word").join(" "));
		expect(out.words).toBe(201);
		expect(out.reading_time_min).toBe(2);
		// An emoji is a single code point via [...text].
		const emoji = await stats("😀");
		expect(emoji.chars).toBe(1);
	});

	it("returns all zeros for empty text", async () => {
		const out = await stats("");
		expect(out).toEqual({ chars: 0, chars_no_spaces: 0, words: 0, lines: 0, sentences: 0, reading_time_min: 0 });
	});
});
