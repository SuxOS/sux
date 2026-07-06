import { describe, expect, it } from "vitest";
import { xmlJson } from "./xml_json";

describe("xml_json", () => {
	it("parses attributes, text, repeated children and self-closing tags", async () => {
		const xml =
			'<root><item id="1">a</item><item id="2">b</item><empty/><meta><flag>on</flag></meta></root>';
		const r = await xmlJson.run({} as any, { data: xml });
		expect(JSON.parse(r.content[0].text)).toEqual({
			root: {
				item: [
					{ "@id": "1", "#text": "a" },
					{ "@id": "2", "#text": "b" },
				],
				empty: "",
				meta: { flag: "on" },
			},
		});
	});

	it("decodes basic entities and CDATA", async () => {
		const xml = "<v><a>1 &lt; 2 &amp; 3</a><b><![CDATA[x <y> z]]></b></v>";
		const r = await xmlJson.run({} as any, { data: xml });
		expect(JSON.parse(r.content[0].text)).toEqual({ v: { a: "1 < 2 & 3", b: "x <y> z" } });
	});

	it("emits XML from JSON with attributes and children", async () => {
		const r = await xmlJson.run({} as any, {
			data: JSON.stringify({ root: { item: { "@id": "1", "#text": "hi & bye" } } }),
			direction: "json_to_xml",
		});
		expect(r.content[0].text).toBe('<root><item id="1">hi &amp; bye</item></root>');
	});

	it("fails on malformed / unclosed XML", async () => {
		const r = await xmlJson.run({} as any, { data: "<a><b></a>" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/xml_to_json failed/);
	});
});
