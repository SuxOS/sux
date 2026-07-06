import { describe, expect, it } from "vitest";
import { optimize } from "./optimize";

describe("optimize", () => {
	it("re-stringifies JSON compactly", async () => {
		const r = await optimize.run({} as any, { data: '{\n  "a": 1,\n  "b": [1, 2, 3]\n}', type: "json" });
		const out = JSON.parse(r.content[0].text);
		expect(out.type).toBe("json");
		expect(out.output).toBe('{"a":1,"b":[1,2,3]}');
		expect(out.out_bytes).toBeLessThan(out.in_bytes);
		expect(out.saved_pct).toBeGreaterThan(0);
	});

	it("strips CSS comments and whitespace (auto-detect)", async () => {
		const css = "/* header */\n.box {\n  color: red;\n  margin: 0;\n}\n";
		const r = await optimize.run({} as any, { data: css });
		const out = JSON.parse(r.content[0].text);
		expect(out.type).toBe("css");
		expect(out.output).toBe(".box{color:red;margin:0}");
	});

	it("keeps string/regex literals intact when minifying JS", async () => {
		const js = "// leading comment\nconst url = 'http://x/y'; // trailing\nconst re = /a\\/\\/b/g;\nconst t = `keep  //  me`;\n";
		const r = await optimize.run({} as any, { data: js, type: "js" });
		const out = JSON.parse(r.content[0].text);
		expect(out.output).toContain("'http://x/y'"); // // inside a string survived
		expect(out.output).toContain("/a\\/\\/b/g"); // regex survived
		expect(out.output).toContain("`keep  //  me`"); // template survived
		expect(out.output).not.toContain("leading comment");
		expect(out.output).not.toContain("trailing");
	});

	it("fails on empty input and invalid JSON", async () => {
		expect((await optimize.run({} as any, { data: "" })).isError).toBe(true);
		expect((await optimize.run({} as any, { data: "{bad", type: "json" })).isError).toBe(true);
	});
});
