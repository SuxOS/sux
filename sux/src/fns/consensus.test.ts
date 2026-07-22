import { afterEach, describe, expect, it, vi } from "vitest";
import { consensus } from "./consensus";

const parse = (r: any) => JSON.parse(r.content[0].text);

function kvStub(seed: Record<string, string> = {}) {
	const map = new Map<string, string>(Object.entries(seed));
	return {
		map,
		get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void map.set(k, v)),
		delete: vi.fn(async (k: string) => void map.delete(k)),
	};
}

const connectedEnv = () =>
	({
		OAUTH_KV: kvStub({
			"sux:consensus:client_id": "CID1",
			"sux:consensus:grant": JSON.stringify({ refresh_token: "RT", issued_at: Date.now() }),
			"sux:consensus:token": "AT",
		}),
	}) as any;

afterEach(() => vi.restoreAllMocks());

describe("consensus fn", () => {
	it("requires a non-empty query", async () => {
		const r = await consensus.run({} as any, { query: "  " });
		expect(r.isError).toBe(true);
	});

	it("is not_configured before the one-time /consensus/connect login", async () => {
		const r = await consensus.run({ OAUTH_KV: kvStub() } as any, { query: "does X help Y" });
		expect(r.errorCode).toBe("not_configured");
		expect(r.content[0].text).toMatch(/consensus\/connect/);
	});

	it("searches and returns the normalized envelope once connected", async () => {
		const env = connectedEnv();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: any, init?: any) => {
				const body = JSON.parse(init.body);
				if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
				if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
				return new Response(
					JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Paper A", year: 2022 }] }) }] } }),
					{ status: 200 },
				);
			}),
		);
		const r = await consensus.run(env, { query: "does X help Y", limit: 3 });
		expect(r.isError).toBeUndefined();
		const out = parse(r);
		expect(out).toEqual({ count: 1, results: [{ title: "Paper A", authors: [], year: 2022, journal: null, snippet: null, doi: null, url: null }] });
	});

	it("reports upstream_error when the MCP call fails", async () => {
		const env = connectedEnv();
		vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
		const r = await consensus.run(env, { query: "q" });
		expect(r.errorCode).toBe("upstream_error");
	});
});
