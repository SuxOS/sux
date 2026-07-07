import { afterEach, describe, expect, it, vi } from "vitest";

import { wolfram } from "./wolfram";

const text = (body: string, status = 200) => new Response(body, { status, headers: { "content-type": "text/plain" } });

const keyedEnv = () => ({ WOLFRAM_APP_ID: "APPID" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("wolfram", () => {
	it("fails clearly when the app id is not configured", async () => {
		const r = await wolfram.run({} as any, { query: "distance from earth to moon" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/WOLFRAM_APP_ID/);
	});

	it("short mode returns the plain-text result and hits the result API with i=", async () => {
		const calls: string[] = [];
		global.fetch = vi.fn(async (u: any) => {
			calls.push(String(u));
			return text("238,900 miles");
		}) as any;
		const r = await wolfram.run(keyedEnv(), { query: "distance from earth to moon", mode: "short" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("238,900 miles");
		expect(calls[0]).toContain("/v1/result");
		expect(calls[0]).toContain("appid=APPID");
		expect(calls[0]).toContain("i=distance");
	});

	it("full mode hits the LLM API with input=", async () => {
		const calls: string[] = [];
		global.fetch = vi.fn(async (u: any) => {
			calls.push(String(u));
			return text("Query: ...\nResult: 238,900 miles\n");
		}) as any;
		const r = await wolfram.run(keyedEnv(), { query: "distance from earth to moon", mode: "full" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/238,900 miles/);
		expect(calls[0]).toContain("/api/v1/llm-api");
		expect(calls[0]).toContain("input=distance");
	});

	it("carries upstream HTTP status into the failure", async () => {
		global.fetch = vi.fn(async () => text("Invalid appid", 403)) as any;
		const r = await wolfram.run(keyedEnv(), { query: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 403/);
	});
});
