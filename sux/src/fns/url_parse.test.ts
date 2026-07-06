import { describe, expect, it } from "vitest";

import { url_parse } from "./url_parse";

describe("url_parse", () => {
	it("rejects an empty url", async () => {
		const r = await url_parse.run({} as any, { url: "" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide a `url`/);
	});

	it("splits a full URL into its parts", async () => {
		const r = await url_parse.run({} as any, { url: "https://host.example:8080/a/b?x=1&y=2#frag" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.protocol).toBe("https:");
		expect(j.hostname).toBe("host.example");
		expect(j.port).toBe("8080");
		expect(j.pathname).toBe("/a/b");
		expect(j.query).toEqual({ x: "1", y: "2" });
		expect(j.hash).toBe("#frag");
		expect(j.origin).toBe("https://host.example:8080");
	});

	it("collapses repeated query keys into an array", async () => {
		const r = await url_parse.run({} as any, { url: "https://x.com/?t=a&t=b" });
		const j = JSON.parse(r.content[0].text);
		expect(j.query.t).toEqual(["a", "b"]);
	});

	it("fails on an invalid URL", async () => {
		const r = await url_parse.run({} as any, { url: "not a url" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Invalid URL/);
	});
});
