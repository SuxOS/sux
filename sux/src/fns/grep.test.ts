import { describe, expect, it, vi } from "vitest";

vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response("alpha\nBETA\ngamma\n", { status: 200 })),
}));

import { smartFetch } from "../proxy";
import { grep } from "./grep";

const TEXT = "alpha\nBeta line\ngamma\nbeta again\ndelta";

describe("grep", () => {
	it("matches lines and reports line numbers", async () => {
		const r = await grep.run({} as any, { pattern: "beta", text: TEXT, ignore_case: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(2);
		expect(out.matches[0].line).toBe(2);
		expect(out.matches[0].text).toBe("Beta line");
	});

	it("is case-sensitive by default", async () => {
		const r = await grep.run({} as any, { pattern: "beta", text: TEXT });
		expect(JSON.parse(r.content[0].text).count).toBe(1); // only "beta again"
	});

	it("includes context lines", async () => {
		const r = await grep.run({} as any, { pattern: "^gamma$", text: TEXT, context: 1 });
		const out = JSON.parse(r.content[0].text);
		expect(out.matches[0].context).toEqual(["Beta line", "gamma", "beta again"]);
	});

	it("fails on invalid regex", async () => {
		const r = await grep.run({} as any, { pattern: "(", text: TEXT });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Invalid regex/);
	});

	it("errors without text or url", async () => {
		const r = await grep.run({} as any, { pattern: "x" });
		expect(r.isError).toBe(true);
	});

	it("fails on an upstream error page instead of grepping it", async () => {
		vi.mocked(smartFetch).mockResolvedValueOnce(new Response("Too Many Requests", { status: 429 }));
		const r = await grep.run({} as any, { pattern: "Requests", url: "https://example.com/big.log" });
		expect(r.isError).toBe(true); // errors never enter the KV cache
		expect(r.content[0].text).toMatch(/HTTP 429/);
	});
});

describe("grep ReDoS guards", () => {
	it("rejects nested-quantifier patterns (catastrophic backtracking)", async () => {
		for (const p of ["(a+)+", "(a*)*", "(.*)+$"]) {
			const r = await grep.run({} as any, { text: "aaaa", pattern: p });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/catastrophic backtracking/);
		}
	});
	it("rejects overlapping-alternation and interval-quantifier groups", async () => {
		for (const p of ["(a|aa)+$", "(a{2,})+b", "(a|aa)*", "(.{1,})+"]) {
			const r = await grep.run({} as any, { text: "aaaa", pattern: p });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/catastrophic backtracking/);
		}
	});
	it("rejects an over-long pattern", async () => {
		const r = await grep.run({} as any, { text: "x", pattern: "a".repeat(1001) });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/too long/);
	});
	it("still allows a normal group pattern", async () => {
		const r = await grep.run({} as any, { text: "abcabc\nxyz", pattern: "(abc)+" });
		expect(r.isError).toBeFalsy();
	});
	it("rejects a nested-group bypass — dangerous quantifier hidden past an inner group's own closing paren", async () => {
		// A single-level `[^)]*` check can never reach past the inner `)` closing
		// `(a+)` to see the outer `)+` — these all previously slipped through.
		for (const p of ["((a+)(a*))+", "((a+))+", "(a(b+)c)+", "((a|b)c)*", "(x(y{2,})z)+"]) {
			const r = await grep.run({} as any, { text: "aaaa", pattern: p });
			expect(r.isError).toBe(true);
			expect(r.content[0].text).toMatch(/catastrophic backtracking/);
		}
	});
	it("still allows safe nested groups (no quantifier/alternation inside, or the inner group isn't itself quantified)", async () => {
		for (const p of ["(a(b)c)+", "(abc)(def)+", "((ab)(cd))+"]) {
			const r = await grep.run({} as any, { text: "abcabc", pattern: p });
			expect(r.isError).toBeFalsy();
		}
	});
	it("doesn't crash on unbalanced or escaped parens", async () => {
		const r1 = await grep.run({} as any, { text: "x", pattern: "(a+" }); // unbalanced -> invalid regex, not a heuristic crash
		expect(r1.isError).toBe(true);
		expect(r1.content[0].text).toMatch(/Invalid regex/);
		const r2 = await grep.run({} as any, { text: "(a+)+", pattern: "\\(a\\+\\)\\+" }); // literal, escaped — not a real group
		expect(r2.isError).toBeFalsy();
	});
});
