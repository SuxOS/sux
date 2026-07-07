import { describe, expect, it } from "vitest";
import { extraCost, weightedRateLimit } from "./rate-limit";

describe("extraCost", () => {
	it("charges cost-1 extra tokens for weighted fns, 0 for default/unknown", () => {
		expect(extraCost("render")).toBe(4);
		expect(extraCost("search")).toBe(2);
		expect(extraCost("summarize")).toBe(1);
		expect(extraCost("hash")).toBe(0);
		expect(extraCost("does_not_exist")).toBe(0);
	});
});

describe("weightedRateLimit", () => {

	const limiter = (budget: number) => {
		let n = 0;
		return { calls: () => n, limit: async () => ({ success: ++n <= budget }) };
	};
	const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });

	it("returns null (proceed) when the tool has no extra cost", async () => {
		const rl = limiter(0);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", call("hash"));
		expect(r).toBeNull();
		expect(rl.calls()).toBe(0);
	});

	it("consumes cost-1 extra tokens and proceeds when under budget", async () => {
		const rl = limiter(10);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", call("render"));
		expect(r).toBeNull();
		expect(rl.calls()).toBe(4);
	});

	it("returns a 429 when the limiter denies mid-way", async () => {
		const rl = limiter(1);
		const r = await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", call("render"));
		expect(r).not.toBeNull();
		expect(r!.status).toBe(429);
		expect(await r!.json()).toEqual({ error: "rate_limited" });
	});

	it("no-ops without a limiter binding or on non-tools/call methods", async () => {
		expect(await weightedRateLimit({} as any, "u", call("render"))).toBeNull();
		const rl = limiter(0);
		expect(await weightedRateLimit({ MCP_RATE_LIMITER: rl } as any, "u", { method: "tools/list" } as any)).toBeNull();
		expect(rl.calls()).toBe(0);
	});
});
