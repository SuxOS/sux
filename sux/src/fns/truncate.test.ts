import { describe, expect, it } from "vitest";
import { truncate } from "./truncate";

const run = (args: any) => truncate.run({} as any, args);

describe("truncate", () => {
	it("rejects a negative or non-integer max", async () => {
		const neg = await run({ text: "hello", max: -1 });
		expect(neg.isError).toBe(true);
		expect(neg.content[0].text).toMatch(/non-negative integer/);
		expect((await run({ text: "hello", max: 2.5 })).isError).toBe(true);
	});

	it("truncates by chars and appends the ellipsis only when cut", async () => {
		const cut = await run({ text: "hello world", max: 5 });
		expect(cut.isError).toBeFalsy();
		expect(cut.content[0].text).toBe("hell…");
		// Fits within budget -> returned verbatim, no ellipsis.
		expect((await run({ text: "hi", max: 10 })).content[0].text).toBe("hi");
	});

	it("truncates by words and by the token heuristic", async () => {
		expect((await run({ text: "one two three four", max: 2, unit: "words" })).content[0].text).toBe("one two…");
		// 2 tokens ≈ 8 chars budget; 7 kept + custom 1-char ellipsis.
		expect((await run({ text: "abcdefghijkl", max: 2, unit: "tokens", ellipsis: "*" })).content[0].text).toBe("abcdefg*");
	});

	it("fails on empty text", async () => {
		const r = await run({ text: "", max: 5 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/non-empty/);
	});
});
