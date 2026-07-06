import { describe, expect, it } from "vitest";
import { case_convert } from "./case_convert";

const run = (args: any) => case_convert.run({} as any, args);

describe("case_convert", () => {
	it("rejects an unknown target casing", async () => {
		const r = await run({ text: "hello world", to: "bogus" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/to must be one of/);
	});

	it("converts across the common styles", async () => {
		expect((await run({ text: "hello world", to: "camel" })).content[0].text).toBe("helloWorld");
		expect((await run({ text: "hello world", to: "pascal" })).content[0].text).toBe("HelloWorld");
		expect((await run({ text: "Hello World", to: "snake" })).content[0].text).toBe("hello_world");
		expect((await run({ text: "hello world", to: "kebab" })).content[0].text).toBe("hello-world");
		expect((await run({ text: "hello world", to: "constant" })).content[0].text).toBe("HELLO_WORLD");
		expect((await run({ text: "hello world", to: "title" })).content[0].text).toBe("Hello World");
	});

	it("splits camelCase and acronym boundaries from any input style", async () => {
		expect((await run({ text: "getHTTPResponseCode", to: "snake" })).content[0].text).toBe("get_http_response_code");
		expect((await run({ text: "my-mixed_Input value", to: "camel" })).content[0].text).toBe("myMixedInputValue");
	});

	it("fails on empty text", async () => {
		const r = await run({ text: "  ", to: "camel" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/non-empty/);
	});
});
