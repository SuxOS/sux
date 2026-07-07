import { afterEach, describe, expect, it, vi } from "vitest";

import { alphavantage } from "./alphavantage";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const QUOTE = {
	"Global Quote": {
		"01. symbol": "IBM",
		"05. price": "185.5000",
		"09. change": "2.3000",
		"10. change percent": "1.2563%",
		"06. volume": "3456789",
		"07. latest trading day": "2026-07-06",
	},
};

const SEARCH = {
	bestMatches: [
		{ "1. symbol": "IBM", "2. name": "International Business Machines", "3. type": "Equity", "4. region": "United States", "8. currency": "USD", "9. matchScore": "1.0000" },
	],
};

const keyedEnv = () => ({ ALPHAVANTAGE_KEY: "KEY" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("alphavantage", () => {
	it("fails clearly when the API key is not configured", async () => {
		const r = await alphavantage.run({} as any, { action: "quote", symbol: "IBM" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/ALPHAVANTAGE_KEY/);
	});

	it("quote normalizes the Global Quote block", async () => {
		const calls: string[] = [];
		global.fetch = vi.fn(async (u: any) => {
			calls.push(String(u));
			return json(QUOTE);
		}) as any;
		const r = await alphavantage.run(keyedEnv(), { action: "quote", symbol: "IBM" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.quote).toMatchObject({
			symbol: "IBM",
			price: 185.5,
			change: 2.3,
			change_percent: "1.2563%",
			volume: 3456789,
			latest_trading_day: "2026-07-06",
		});
		expect(calls[0]).toContain("function=GLOBAL_QUOTE");
		expect(calls[0]).toContain("symbol=IBM");
		expect(calls[0]).toContain("apikey=KEY");
	});

	it("search normalizes bestMatches", async () => {
		const calls: string[] = [];
		global.fetch = vi.fn(async (u: any) => {
			calls.push(String(u));
			return json(SEARCH);
		}) as any;
		const r = await alphavantage.run(keyedEnv(), { action: "search", term: "IBM" });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.count).toBe(1);
		expect(j.matches[0]).toMatchObject({ symbol: "IBM", name: "International Business Machines", currency: "USD", match_score: 1 });
		expect(calls[0]).toContain("function=SYMBOL_SEARCH");
		expect(calls[0]).toContain("keywords=IBM");
	});

	it("surfaces a rate-limit Note as an error", async () => {
		global.fetch = vi.fn(async () => json({ Note: "Thank you for using Alpha Vantage! rate limit" })) as any;
		const r = await alphavantage.run(keyedEnv(), { action: "quote", symbol: "IBM" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/rate limit/);
	});

	it("carries upstream HTTP status into the failure", async () => {
		global.fetch = vi.fn(async () => json({}, 503)) as any;
		const r = await alphavantage.run(keyedEnv(), { action: "quote", symbol: "IBM" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HTTP 503/);
	});
});
