import { describe, expect, it } from "vitest";
import { csvJson } from "./csv_json";

describe("csv_json", () => {
	it("parses CSV with quoted fields (embedded comma/quote/newline)", async () => {
		const csv = 'name,note\n"Doe, John","said ""hi""\nbye"\nJane,plain';
		const r = await csvJson.run({} as any, { data: csv });
		const rows = JSON.parse(r.content[0].text);
		expect(rows).toEqual([
			{ name: "Doe, John", note: 'said "hi"\nbye' },
			{ name: "Jane", note: "plain" },
		]);
	});

	it("round-trips JSON -> CSV -> JSON", async () => {
		const arr = [{ a: "1", b: "x,y" }, { a: "2", b: "z" }];
		const toCsv = await csvJson.run({} as any, { data: JSON.stringify(arr), direction: "json_to_csv" });
		const csv = toCsv.content[0].text;
		expect(csv.split("\n")[0]).toBe("a,b");
		expect(csv).toContain('"x,y"');
		const back = await csvJson.run({} as any, { data: csv });
		expect(JSON.parse(back.content[0].text)).toEqual(arr);
	});

	it("honours a custom delimiter", async () => {
		const r = await csvJson.run({} as any, { data: "a;b\n1;2", delimiter: ";" });
		expect(JSON.parse(r.content[0].text)).toEqual([{ a: "1", b: "2" }]);
	});

	it("rejects non-array JSON for json_to_csv", async () => {
		const r = await csvJson.run({} as any, { data: '{"a":1}', direction: "json_to_csv" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/array of objects/);
	});
});
