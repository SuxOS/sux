import { afterEach, describe, expect, it, vi } from "vitest";
import { icd10 } from "./icd10";

const BODY = [
	2,
	["E11.9", "E11.65"],
	null,
	[
		["E11.9", "Type 2 diabetes mellitus without complications"],
		["E11.65", "Type 2 diabetes mellitus with hyperglycemia"],
	],
];

afterEach(() => vi.restoreAllMocks());

describe("icd10", () => {
	it("normalizes the NLM 4-element response into { code, name }", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await icd10.run({} as any, { term: "type 2 diabetes" });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(2);
		expect(out.results[0]).toEqual({ code: "E11.9", name: "Type 2 diabetes mellitus without complications" });
	});

	it("errors without a term", async () => {
		const r = await icd10.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
		const r = await icd10.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/503/);
	});
});
