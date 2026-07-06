import { describe, expect, it } from "vitest";
import { count_tokens } from "./count_tokens";

describe("count_tokens", () => {
	it("rejects a non-string text", async () => {
		const r = await count_tokens.run({} as any, { text: 123 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/text is required/);
	});

	it("estimates tokens for a sentence", async () => {
		const r = await count_tokens.run({} as any, { text: "The quick brown fox jumps over the lazy dog." });
		expect(r.isError).toBeFalsy();
		const meta = JSON.parse(r.content[0].text);
		expect(meta.chars).toBe(44);
		expect(meta.words).toBe(9);
		// chars/4 = 11, words*1.3 = 12 -> max = 12
		expect(meta.est_tokens).toBe(12);
	});

	it("counts unicode by code point, not UTF-16 units", async () => {
		const r = await count_tokens.run({} as any, { text: "🙂🙂" });
		const meta = JSON.parse(r.content[0].text);
		expect(meta.chars).toBe(2); // two code points, not four
		expect(meta.words).toBe(1);
		expect(meta.est_tokens).toBeGreaterThanOrEqual(1);
	});

	it("returns zeros for empty text", async () => {
		const r = await count_tokens.run({} as any, { text: "" });
		expect(JSON.parse(r.content[0].text)).toEqual({ chars: 0, words: 0, est_tokens: 0 });
	});
});
