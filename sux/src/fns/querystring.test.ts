import { describe, expect, it } from "vitest";

import { querystring } from "./querystring";

describe("querystring", () => {
	it("rejects a build with a non-object data", async () => {
		const r = await querystring.run({} as any, { data: "not-an-object", direction: "build" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/must be a JSON object/);
	});

	it("parses a query string into an object", async () => {
		const r = await querystring.run({} as any, { data: "a=1&b=2&c=hello%20world" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j).toEqual({ a: "1", b: "2", c: "hello world" });
	});

	it("collapses repeated keys into an array and accepts a full URL", async () => {
		const r = await querystring.run({} as any, { data: "https://x.com/p?tag=a&tag=b&tag=c&q=z" });
		const j = JSON.parse(r.content[0].text);
		expect(j.tag).toEqual(["a", "b", "c"]);
		expect(j.q).toBe("z");
	});

	it("builds an encoded query string, expanding array values", async () => {
		const r = await querystring.run({} as any, { data: { q: "a b", tag: ["x", "y"] }, direction: "build" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("q=a+b&tag=x&tag=y");
	});
});
