import { describe, expect, it } from "vitest";
import { yamlJson } from "./yaml_json";

describe("yaml_json", () => {
	it("parses nested maps, sequences, scalars and comments", async () => {
		const yaml = [
			"# a config",
			"name: demo",
			"count: 3",
			"active: true",
			"nothing: null",
			"server:",
			"  host: localhost",
			"  port: 8080",
			"tags:",
			"  - one",
			"  - two",
		].join("\n");
		const r = await yamlJson.run({} as any, { data: yaml });
		expect(JSON.parse(r.content[0].text)).toEqual({
			name: "demo",
			count: 3,
			active: true,
			nothing: null,
			server: { host: "localhost", port: 8080 },
			tags: ["one", "two"],
		});
	});

	it("parses a sequence of maps (- key: value)", async () => {
		const yaml = "items:\n  - id: 1\n    label: a\n  - id: 2\n    label: b";
		const r = await yamlJson.run({} as any, { data: yaml });
		expect(JSON.parse(r.content[0].text)).toEqual({
			items: [
				{ id: 1, label: "a" },
				{ id: 2, label: "b" },
			],
		});
	});

	it("emits YAML from JSON", async () => {
		const r = await yamlJson.run({} as any, {
			data: JSON.stringify({ name: "x", nested: { a: 1 }, list: ["p", "q"] }),
			direction: "json_to_yaml",
		});
		const yaml = r.content[0].text;
		expect(yaml).toContain("name: x");
		expect(yaml).toContain("nested:");
		expect(yaml).toContain("  a: 1");
		expect(yaml).toContain("- p");
	});

	it("round-trips JSON with an array of objects through YAML", async () => {
		const obj = { users: [{ name: "a", age: 1 }, { name: "b", age: 2 }], empty: [] };
		const yaml = (await yamlJson.run({} as any, { data: JSON.stringify(obj), direction: "json_to_yaml" })).content[0].text;
		expect(yaml).toContain("- name: a");
		const back = (await yamlJson.run({} as any, { data: yaml })).content[0].text;
		expect(JSON.parse(back)).toEqual({ users: [{ name: "a", age: 1 }, { name: "b", age: 2 }], empty: [] });
	});

	it("fails on invalid JSON for json_to_yaml", async () => {
		const r = await yamlJson.run({} as any, { data: "{not json", direction: "json_to_yaml" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/json_to_yaml failed/);
	});
});
