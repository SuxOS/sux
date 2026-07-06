import { describe, expect, it } from "vitest";
import { htmlentities } from "./htmlentities";

const run = async (args: any) => (await htmlentities.run({} as any, args)).content[0].text;

describe("htmlentities", () => {
	it("rejects an invalid direction", async () => {
		const r = await htmlentities.run({} as any, { text: "x", direction: "sideways" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/direction must be/);
	});

	it("encodes markup chars and non-ascii to numeric refs", async () => {
		const out = await run({ text: `a & b < c > "d" 'e' café`, direction: "encode" });
		expect(out).toBe(`a &amp; b &lt; c &gt; &quot;d&quot; &#39;e&#39; caf&#233;`);
	});

	it("leaves non-ascii intact when non_ascii=false", async () => {
		const out = await run({ text: "café & <x>", direction: "encode", non_ascii: false });
		expect(out).toBe("café &amp; &lt;x&gt;");
	});

	it("decodes named, decimal, and hex refs (unknown names untouched)", async () => {
		const out = await run({ text: "&amp; &lt; &#233; &#xe9; &copy; &notareal;", direction: "decode" });
		expect(out).toBe("& < é é © &notareal;");
	});
});
