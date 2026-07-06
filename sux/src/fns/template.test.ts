import { describe, expect, it } from "vitest";
import { template } from "./template";

describe("template", () => {
	it("rejects a non-object vars", async () => {
		const r = await template.run({} as any, { template: "hi {{x}}", vars: "nope" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/`vars` as an object/);
	});

	it("fills flat and dotted placeholders", async () => {
		const r = await template.run({} as any, {
			template: "Hi {{name}}, you live in {{addr.city}}.",
			vars: { name: "Ada", addr: { city: "London" } },
		});
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("Hi Ada, you live in London.");
	});

	it("keeps unresolved placeholders by default and empties them on request", async () => {
		const keep = await template.run({} as any, { template: "a {{missing}} b", vars: {} });
		expect(keep.content[0].text).toBe("a {{missing}} b");
		const empty = await template.run({} as any, { template: "a {{missing}} b", vars: {}, missing: "empty" });
		expect(empty.content[0].text).toBe("a  b");
	});

	it("errors listing the missing keys when missing=error", async () => {
		const r = await template.run({} as any, { template: "{{a}} {{b.c}}", vars: { a: 1 }, missing: "error" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/b\.c/);
	});
});
