import { describe, expect, it } from "vitest";
import { colorConvert } from "./color_convert";

const run = async (args: any) => {
	const r = await colorConvert.run({} as any, args);
	return { r, out: r.isError ? null : JSON.parse(r.content[0].text) };
};

describe("color_convert", () => {
	it("rejects an unparseable color and a bad target", async () => {
		const bad = await run({ value: "notacolor", to: "hex" });
		expect(bad.r.isError).toBe(true);
		expect(bad.r.content[0].text).toMatch(/Could not parse/);
		expect((await run({ value: "#3af", to: "cmyk" })).r.isError).toBe(true);
	});

	it("expands 3-digit hex to rgb", async () => {
		expect((await run({ value: "#3af", to: "rgb" })).out.result).toBe("rgb(51, 170, 255)");
	});

	it("round-trips rgb -> hsl -> rgb for a saturated color", async () => {
		const hsl = (await run({ value: "rgb(51,170,255)", to: "hsl" })).out.result;
		expect(hsl).toBe("hsl(205, 100%, 60%)");
		expect((await run({ value: hsl, to: "rgb" })).out.result).toBe("rgb(51, 170, 255)");
	});

	it("handles grayscale (zero saturation) and hex output", async () => {
		expect((await run({ value: "rgb(128,128,128)", to: "hsl" })).out.result).toBe("hsl(0, 0%, 50%)");
		expect((await run({ value: "rgb(0,0,0)", to: "hex" })).out.result).toBe("#000000");
	});
});
