import { afterEach, describe, expect, it, vi } from "vitest";
import { challengeFor, consensusClientId, consensusSearch, handleConsensusRoutes, hasConsensusGrant, makeVerifier, mintAccessToken, readGrant } from "./consensus";

const AUTHORIZE_URL = "https://consensus.app/oauth/authorize/";
const TOKEN_URL = "https://consensus.app/oauth/token/";
const REGISTER_URL = "https://consensus.app/oauth/register/";
const MCP_URL = "https://mcp.consensus.app/mcp";

function kvStub(seed: Record<string, string> = {}) {
	const map = new Map<string, string>(Object.entries(seed));
	return {
		map,
		get: vi.fn(async (k: string) => (map.has(k) ? map.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void map.set(k, v)),
		delete: vi.fn(async (k: string) => void map.delete(k)),
	};
}

const baseEnv = (over: Record<string, unknown> = {}) => ({ OAUTH_KV: kvStub(), ...over }) as any;

afterEach(() => vi.restoreAllMocks());

describe("PKCE helpers", () => {
	it("makeVerifier produces a high-entropy base64url string with no padding", () => {
		const v = makeVerifier();
		expect(v.length).toBeGreaterThanOrEqual(43);
		expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("challengeFor is deterministic S256(verifier)", async () => {
		const a = await challengeFor("same-verifier");
		const b = await challengeFor("same-verifier");
		expect(a).toBe(b);
		expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
		const c = await challengeFor("different-verifier");
		expect(c).not.toBe(a);
	});
});

describe("consensusClientId (dynamic client registration)", () => {
	it("registers once via /oauth/register/ and caches the client_id in KV", async () => {
		const env = baseEnv();
		const fetchMock = vi.fn(async (u: any, init?: any) => {
			expect(String(u)).toBe(REGISTER_URL);
			const body = JSON.parse(init.body);
			expect(body.token_endpoint_auth_method).toBe("none");
			expect(body.redirect_uris).toEqual(["https://suxos.net/consensus/callback"]);
			return new Response(JSON.stringify({ client_id: "CID1" }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const id = await consensusClientId(env);
		expect(id).toBe("CID1");
		expect(env.OAUTH_KV.map.get("sux:consensus:client_id")).toBe("CID1");

		// second call reuses the cache — no second registration fetch.
		const id2 = await consensusClientId(env);
		expect(id2).toBe("CID1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("throws when registration fails", async () => {
		const env = baseEnv();
		vi.stubGlobal("fetch", vi.fn(async () => new Response("boom", { status: 500 })));
		await expect(consensusClientId(env)).rejects.toThrow(/registration failed/);
	});
});

describe("hasConsensusGrant / readGrant", () => {
	it("false/null before connecting, true/populated after a grant is stored", async () => {
		const env = baseEnv();
		expect(await hasConsensusGrant(env)).toBe(false);
		expect(await readGrant(env)).toBeNull();
		await env.OAUTH_KV.put("sux:consensus:grant", JSON.stringify({ refresh_token: "RT", issued_at: 1 }));
		expect(await hasConsensusGrant(env)).toBe(true);
		expect((await readGrant(env))?.refresh_token).toBe("RT");
	});
});

describe("consensus token lifecycle (mint / rotate)", () => {
	it("throws a not-connected error pointing at /consensus/connect when no grant exists", async () => {
		const env = baseEnv();
		await expect(mintAccessToken(env)).rejects.toThrow(/consensus\/connect/);
	});

	it("mints from the refresh grant with NO Basic auth (public client), persists a ROTATED refresh token", async () => {
		const env = baseEnv({ OAUTH_KV: kvStub({ "sux:consensus:client_id": "CID1", "sux:consensus:grant": JSON.stringify({ refresh_token: "OLD_RT", issued_at: 1 }) }) });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				expect(String(u)).toBe(TOKEN_URL);
				expect(init.headers.Authorization).toBeUndefined();
				expect(String(init.body)).toContain("grant_type=refresh_token");
				expect(String(init.body)).toContain("refresh_token=OLD_RT");
				expect(String(init.body)).toContain("client_id=CID1");
				return new Response(JSON.stringify({ access_token: "AT2", refresh_token: "NEW_RT", expires_in: 3600 }), { status: 200 });
			}),
		);
		const tok = await mintAccessToken(env);
		expect(tok).toBe("AT2");
		expect(env.OAUTH_KV.map.get("sux:consensus:token")).toBe("AT2");
		expect(JSON.parse(env.OAUTH_KV.map.get("sux:consensus:grant")!).refresh_token).toBe("NEW_RT");
	});

	it("keeps the old refresh token when the response doesn't rotate it", async () => {
		const env = baseEnv({ OAUTH_KV: kvStub({ "sux:consensus:client_id": "CID1", "sux:consensus:grant": JSON.stringify({ refresh_token: "KEEP_RT", issued_at: 1 }) }) });
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ access_token: "AT", expires_in: 3600 }), { status: 200 })));
		await mintAccessToken(env);
		expect(JSON.parse(env.OAUTH_KV.map.get("sux:consensus:grant")!).refresh_token).toBe("KEEP_RT");
	});
});

describe("/consensus/connect gate — Bearer-authed", () => {
	const req = (u: string, bearer?: string) => new Request(u, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : undefined);
	const U = "https://suxos.net/consensus/connect";

	it("404s when the operator token is unset, 401 on a missing/wrong bearer, 302 with S256 + client_id when correct", async () => {
		const noGate = baseEnv();
		expect((await handleConsensusRoutes(new URL(U), req(U), noGate))?.status).toBe(404);

		const env = baseEnv({ SUX_CRON_TOKEN: "op-secret" });
		expect((await handleConsensusRoutes(new URL(U), req(U), env))?.status).toBe(401);
		expect((await handleConsensusRoutes(new URL(U), req(U, "wrong"), env))?.status).toBe(401);

		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ client_id: "CID1" }), { status: 200 })));
		const resp = await handleConsensusRoutes(new URL(U), req(U, "op-secret"), env);
		expect(resp?.status).toBe(302);
		const loc = new URL(resp!.headers.get("location")!);
		expect(loc.origin + loc.pathname).toBe(AUTHORIZE_URL);
		expect(loc.searchParams.get("client_id")).toBe("CID1");
		expect(loc.searchParams.get("code_challenge_method")).toBe("S256");
		expect(loc.searchParams.get("redirect_uri")).toBe("https://suxos.net/consensus/callback");
		const state = loc.searchParams.get("state")!;
		expect(env.OAUTH_KV.map.has(`sux:consensus:pkce:${state}`)).toBe(true);
	});
});

describe("/consensus/callback (PKCE round-trip)", () => {
	it("exchanges code+verifier with NO Basic auth, persists the grant, caches the access token", async () => {
		const env = baseEnv({ OAUTH_KV: kvStub({ "sux:consensus:client_id": "CID1" }) });
		await env.OAUTH_KV.put("sux:consensus:pkce:STATE1", JSON.stringify({ verifier: "VERIFIER123", created: Date.now() }));
		const seen: any = {};
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				expect(String(u)).toBe(TOKEN_URL);
				seen.body = init.body;
				seen.auth = init.headers.Authorization;
				return new Response(JSON.stringify({ access_token: "AT1", refresh_token: "RT1", scope: "search profile", expires_in: 3600 }), { status: 200 });
			}),
		);
		const u = "https://suxos.net/consensus/callback?code=CODE1&state=STATE1";
		const resp = await handleConsensusRoutes(new URL(u), new Request(u), env);
		expect(resp?.status).toBe(200);
		expect(await resp!.text()).toContain("Consensus connected");
		expect(seen.auth).toBeUndefined();
		expect(String(seen.body)).toContain("grant_type=authorization_code");
		expect(String(seen.body)).toContain("code_verifier=VERIFIER123");
		expect(String(seen.body)).toContain("client_id=CID1");
		const grant = await readGrant(env);
		expect(grant).toMatchObject({ refresh_token: "RT1", scope: "search profile" });
		expect(env.OAUTH_KV.map.get("sux:consensus:token")).toBe("AT1");
		expect(env.OAUTH_KV.map.has("sux:consensus:pkce:STATE1")).toBe(false);
	});

	it("serves the reflected `error` param as text/plain", async () => {
		const env = baseEnv();
		const xss = "<script>alert(1)</script>";
		const u = `https://suxos.net/consensus/callback?error=${encodeURIComponent(xss)}`;
		const resp = await handleConsensusRoutes(new URL(u), new Request(u), env);
		expect(resp?.status).toBe(400);
		expect(resp!.headers.get("content-type")).toMatch(/text\/plain/);
	});

	it("refuses an unknown/expired state (CSRF check)", async () => {
		const env = baseEnv();
		const u = "https://suxos.net/consensus/callback?code=X&state=NOPE";
		const resp = await handleConsensusRoutes(new URL(u), new Request(u), env);
		expect(resp?.status).toBe(400);
		expect(await resp!.text()).toMatch(/CSRF/i);
	});

	it("refuses a PKCE state with no stored verifier (corrupt state)", async () => {
		const env = baseEnv();
		await env.OAUTH_KV.put("sux:consensus:pkce:STATE2", JSON.stringify({ created: Date.now() }));
		const u = "https://suxos.net/consensus/callback?code=X&state=STATE2";
		const resp = await handleConsensusRoutes(new URL(u), new Request(u), env);
		expect(resp?.status).toBe(400);
		expect(await resp!.text()).toMatch(/Corrupt PKCE state/i);
	});
});

describe("consensusSearch (MCP JSON-RPC envelope)", () => {
	function paper(text: unknown) {
		return { type: "text", text: typeof text === "string" ? text : JSON.stringify(text) };
	}

	it("initializes, sends notifications/initialized, calls tools/call('search') with a Bearer token, and normalizes content[0].text JSON", async () => {
		const env = baseEnv({ OAUTH_KV: kvStub({ "sux:consensus:client_id": "CID1", "sux:consensus:token": "AT" }) });
		const seenMethods: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				expect(String(u)).toBe(MCP_URL);
				expect(init.headers.Authorization).toBe("Bearer AT");
				const body = JSON.parse(init.body);
				seenMethods.push(body.method);
				if (body.method === "initialize") {
					return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), { status: 200, headers: { "mcp-session-id": "SESS1", "content-type": "application/json" } });
				}
				if (body.method === "notifications/initialized") {
					expect(init.headers["Mcp-Session-Id"]).toBe("SESS1");
					return new Response(null, { status: 202 });
				}
				if (body.method === "tools/call") {
					expect(body.params.name).toBe("search");
					expect(body.params.arguments).toMatchObject({ query: "does X help Y", year_min: 2015, limit: 5 });
					return new Response(
						JSON.stringify({
							jsonrpc: "2.0",
							id: 2,
							result: { content: [paper({ results: [{ title: "Paper A", authors: ["Alice"], year: 2020, journal: "J", abstract: "snip", doi: "10.1/x", url: "http://x" }] })] },
						}),
						{ status: 200 },
					);
				}
				throw new Error(`unexpected method ${body.method}`);
			}),
		);
		const result = await consensusSearch(env, { query: "does X help Y", year_min: 2015, limit: 5 });
		expect(seenMethods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
		expect(result).toEqual({ count: 1, results: [{ title: "Paper A", authors: ["Alice"], year: 2020, journal: "J", snippet: "snip", doi: "10.1/x", url: "http://x" }] });
	});

	it("normalizes a structuredContent payload keyed under 'papers'", async () => {
		const env = baseEnv({ OAUTH_KV: kvStub({ "sux:consensus:client_id": "CID1", "sux:consensus:token": "AT" }) });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: any, init?: any) => {
				const body = JSON.parse(init.body);
				if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
				if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { structuredContent: { papers: [{ title: "B", authors: [{ name: "Bob" }], year: 2021 }] } } }), { status: 200 });
			}),
		);
		const result = await consensusSearch(env, { query: "q" });
		expect(result.count).toBe(1);
		expect(result.results[0]).toMatchObject({ title: "B", authors: ["Bob"], year: 2021, journal: null, doi: null });
	});

	it("parses a text/event-stream response (SSE framing)", async () => {
		const env = baseEnv({ OAUTH_KV: kvStub({ "sux:consensus:client_id": "CID1", "sux:consensus:token": "AT" }) });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_u: any, init?: any) => {
				const body = JSON.parse(init.body);
				if (body.method === "initialize") {
					return new Response('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n', { status: 200, headers: { "content-type": "text/event-stream" } });
				}
				if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
				return new Response(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [paper({ results: [] })] } })}\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
			}),
		);
		const result = await consensusSearch(env, { query: "q" });
		expect(result).toEqual({ count: 0, results: [] });
	});

	it("self-heals ONCE on a 401: drops the cached token and re-mints from the refresh grant", async () => {
		const env = baseEnv({
			OAUTH_KV: kvStub({ "sux:consensus:client_id": "CID1", "sux:consensus:token": "STALE_AT", "sux:consensus:grant": JSON.stringify({ refresh_token: "RT", issued_at: 1 }) }),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any, init?: any) => {
				const url = String(u);
				if (url === TOKEN_URL) return new Response(JSON.stringify({ access_token: "FRESH_AT", expires_in: 3600 }), { status: 200 });
				expect(url).toBe(MCP_URL);
				const auth = init.headers.Authorization;
				if (auth === "Bearer STALE_AT") return new Response("unauthorized", { status: 401 });
				expect(auth).toBe("Bearer FRESH_AT");
				const body = JSON.parse(init.body);
				if (body.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), { status: 200 });
				if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
				return new Response(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [paper({ results: [] })] } }), { status: 200 });
			}),
		);
		const result = await consensusSearch(env, { query: "q" });
		expect(result).toEqual({ count: 0, results: [] });
		expect(env.OAUTH_KV.map.get("sux:consensus:token")).toBe("FRESH_AT");
	});

	it("throws when still unauthorized after the one-time refresh", async () => {
		const env = baseEnv({
			OAUTH_KV: kvStub({ "sux:consensus:client_id": "CID1", "sux:consensus:token": "STALE_AT", "sux:consensus:grant": JSON.stringify({ refresh_token: "RT", issued_at: 1 }) }),
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: any) => {
				const url = String(u);
				if (url === TOKEN_URL) return new Response(JSON.stringify({ access_token: "FRESH_AT", expires_in: 3600 }), { status: 200 });
				return new Response("unauthorized", { status: 401 });
			}),
		);
		await expect(consensusSearch(env, { query: "q" })).rejects.toThrow(/unauthorized/i);
	});
});
