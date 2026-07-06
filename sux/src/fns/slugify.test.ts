import { describe, expect, it } from "vitest";
import { slugify } from "./slugify";

const run = (args: any) => slugify.run({} as any, args);

describe("slugify", () => {
	it("rejects empty text", async () => {
		const r = await run({ text: "   " });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/non-empty/);
	});

	it("lowercases, strips accents, and collapses separators", async () => {
		expect((await run({ text: "  Héllo,  Wörld!  " })).content[0].text).toBe("hello-world");
		expect((await run({ text: "Crème brûlée" })).content[0].text).toBe("creme-brulee");
	});

	it("honors a custom separator and a max length without a dangling sep", async () => {
		expect((await run({ text: "Hello World Again", sep: "_" })).content[0].text).toBe("hello_world_again");
		// max cut lands mid-separator -> trailing sep removed.
		expect((await run({ text: "hello world", max: 6 })).content[0].text).toBe("hello");
	});

	it("rejects an invalid max", async () => {
		const r = await run({ text: "abc", max: 0 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/positive integer/);
	});
});
