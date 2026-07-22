// Consensus.app academic search — OAuth PKCE (public client, dynamic client
// registration) + the two public routes (/consensus/connect, /consensus/callback)
// plus the streamable-HTTP MCP JSON-RPC call the `consensus` fn (fns/consensus.ts)
// runs against. Mirrors src/mychart.ts's OAuth machinery (PKCE dance, KV-held
// refresh grant, 401 self-heal) — simpler here: a single Pro account, not a
// multi-org registry, and a PUBLIC client (token_endpoint_auth_methods_supported
// is ["none"]) — dynamic client registration (`/oauth/register/`) mints the
// client_id once per deployment and caches it in KV (not a secret, nothing to
// protect: a public client has none), and the token endpoint call never sends
// Basic auth or a client secret.
//
// Design: issue #1297. All endpoints below were live-verified against
// consensus.app/mcp.consensus.app on 2026-07-22 (anonymous POST to the MCP
// endpoint = 401, confirming OAuth is required).

import { timingSafeEqual } from "./crypto-util";
import { escapeHtml } from "./mychart";
import type { RtEnv } from "./registry";
import { safeParseJson } from "./fns/_util";

const AUTH_BASE = "https://consensus.app";
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize/`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token/`;
const REGISTER_URL = `${AUTH_BASE}/oauth/register/`;
export const MCP_URL = "https://mcp.consensus.app/mcp";

const CLIENT_ID_KEY = "sux:consensus:client_id";
const GRANT_KEY = "sux:consensus:grant";
const ACCESS_TOKEN_KEY = "sux:consensus:token";
const pkceKey = (state: string): string => `sux:consensus:pkce:${state}`;

const SCOPES = "search profile";
const PKCE_TTL_S = 600; // 10 min — the interactive login must complete inside this.

export interface ConsensusGrant {
	refresh_token: string;
	scope?: string;
	issued_at: number;
}

const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
// Error/status responses interpolating caller- or upstream-supplied values are served
// as text/plain (never HTML) so an echoed error string can never execute — same
// reflected-XSS defense mychart.ts's TEXT_HEADERS documents.
const TEXT_HEADERS = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

const b64url = (bytes: Uint8Array): string => {
	let s = "";
	for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** A high-entropy PKCE code_verifier (RFC 7636 — 43-128 chars, base64url alphabet). */
export function makeVerifier(): string {
	return b64url(crypto.getRandomValues(new Uint8Array(48)));
}

/** S256 challenge = base64url(SHA-256(verifier)). */
export async function challengeFor(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return b64url(new Uint8Array(digest));
}

/** Public base for the callback redirect URI — must match the registered
 * redirect_uris exactly. Shares STORE_BASE with the `store` handles (same pattern
 * as mychart.ts's redirectUri) so a staging deploy points its callback at itself;
 * defaults to the prod host. */
export function redirectUri(env: RtEnv): string {
	const v = (env as { STORE_BASE?: string }).STORE_BASE;
	const base = (typeof v === "string" && v ? v : "https://suxos.net").replace(/\/+$/, "");
	return `${base}/consensus/callback`;
}

export async function readGrant(env: RtEnv): Promise<ConsensusGrant | null> {
	const raw = await env.OAUTH_KV?.get(GRANT_KEY);
	return safeParseJson<ConsensusGrant | null>(raw, null);
}

/** True once the one-time /consensus/connect login has been completed. */
export async function hasConsensusGrant(env: RtEnv): Promise<boolean> {
	return Boolean((await readGrant(env))?.refresh_token);
}

/** The dynamic-client-registration client_id, minted once per deployment via
 * `/oauth/register/` and cached in KV — a public value, not a secret
 * (token_endpoint_auth_methods_supported is ["none"], so there is no client secret
 * to protect). Idempotent: a cached id short-circuits the registration call. */
export async function consensusClientId(env: RtEnv): Promise<string> {
	const cached = await env.OAUTH_KV?.get(CLIENT_ID_KEY);
	if (cached) return cached;
	const resp = await fetch(REGISTER_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({
			redirect_uris: [redirectUri(env)],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			client_name: "sux",
		}),
		signal: AbortSignal.timeout(20_000),
	});
	const json: any = await resp.json().catch(() => null);
	if (!resp.ok || !json?.client_id) throw new Error(`Consensus client registration failed: HTTP ${resp.status}`);
	await env.OAUTH_KV?.put(CLIENT_ID_KEY, String(json.client_id));
	return String(json.client_id);
}

/** POST the token endpoint with a URL-encoded body — public client, so no Basic
 * auth header (unlike mychart's confidential-client tokenPost). */
async function tokenPost(body: Record<string, string>): Promise<{ status: number; json: any }> {
	const resp = await fetch(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams(body).toString(),
		signal: AbortSignal.timeout(20_000),
	});
	return { status: resp.status, json: await resp.json().catch(() => null) };
}

/** Cache a freshly-minted access token in KV (TTL = expires_in - 60, KV's 60s floor). */
async function cacheAccessToken(env: RtEnv, accessToken: string, expiresIn: unknown): Promise<void> {
	const ttl = Math.max(60, (Number(expiresIn) || 3600) - 60);
	await env.OAUTH_KV?.put(ACCESS_TOKEN_KEY, accessToken, { expirationTtl: ttl });
}

/** Mint an access token from the stored refresh grant, PERSISTING any rotated
 * refresh_token back to the grant before returning (same rotation-safety as
 * mychart's mintAccessToken). Throws a not-connected error pointing at
 * /consensus/connect when no grant exists. */
export async function mintAccessToken(env: RtEnv): Promise<string> {
	const grant = await readGrant(env);
	if (!grant?.refresh_token) throw new Error("Consensus not connected — no grant in KV. Open /consensus/connect once to link your Pro account.");
	const clientId = await consensusClientId(env);
	const { status, json } = await tokenPost({ grant_type: "refresh_token", refresh_token: grant.refresh_token, client_id: clientId });
	if (status >= 400 || !json?.access_token) {
		const code = typeof json?.error === "string" ? json.error.replace(/[^A-Za-z0-9_\-]/g, "").slice(0, 40) : "no_access_token";
		throw new Error(`Consensus token refresh HTTP ${status} (${code})`);
	}
	if (typeof json.refresh_token === "string" && json.refresh_token && json.refresh_token !== grant.refresh_token) {
		const updated: ConsensusGrant = { ...grant, refresh_token: json.refresh_token, issued_at: Date.now(), scope: json.scope ?? grant.scope };
		await env.OAUTH_KV?.put(GRANT_KEY, JSON.stringify(updated));
	}
	await cacheAccessToken(env, String(json.access_token), json.expires_in);
	return String(json.access_token);
}

/** Resolve a bearer: KV-cached access token, else a fresh mint from the refresh grant. */
export async function accessToken(env: RtEnv): Promise<string> {
	const cached = await env.OAUTH_KV?.get(ACCESS_TOKEN_KEY);
	if (cached) return cached;
	return mintAccessToken(env);
}

// ---------------- MCP JSON-RPC call ----------------

function jsonRpcBody(id: number | null, method: string, params?: unknown): string {
	return JSON.stringify(id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params });
}

/** Parse a streamable-HTTP MCP response body: either plain JSON, or an SSE stream
 * of `data: {...}` frames (the transport spec allows either) — the LAST parsed
 * frame is the terminal response for a single request/response pair. */
function parseMcpBody(text: string, contentType: string): any {
	if (!contentType.includes("text/event-stream")) return JSON.parse(text);
	let last: any = null;
	for (const line of text.split("\n")) {
		const m = /^data:\s*(.+)$/.exec(line.trim());
		if (m) {
			try {
				last = JSON.parse(m[1]);
			} catch {
				/* ignore a malformed frame — keep the last good one */
			}
		}
	}
	return last;
}

async function mcpCall(token: string, id: number | null, method: string, params: unknown, sessionId?: string): Promise<{ status: number; json: any; sessionId?: string }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		Authorization: `Bearer ${token}`,
	};
	if (sessionId) headers["Mcp-Session-Id"] = sessionId;
	const resp = await fetch(MCP_URL, { method: "POST", headers, body: jsonRpcBody(id, method, params), signal: AbortSignal.timeout(30_000) });
	const newSessionId = resp.headers.get("mcp-session-id") ?? sessionId;
	if (resp.status === 202 || resp.status === 204) return { status: resp.status, json: null, sessionId: newSessionId }; // notification ack, no body
	const text = await resp.text();
	if (!text) return { status: resp.status, json: null, sessionId: newSessionId };
	let json: any = null;
	try {
		json = parseMcpBody(text, resp.headers.get("content-type") ?? "");
	} catch {
		/* leave json null — the caller treats a missing body as upstream_error */
	}
	return { status: resp.status, json, sessionId: newSessionId };
}

export interface ConsensusPaper {
	title: string | null;
	authors: string[];
	year: number | null;
	journal: string | null;
	snippet: string | null;
	doi: string | null;
	url: string | null;
}

function normPaper(d: any): ConsensusPaper {
	const authors = Array.isArray(d?.authors) ? d.authors.map((a: any) => (typeof a === "string" ? a : a?.name)).filter(Boolean) : [];
	return {
		title: d?.title ?? null,
		authors,
		year: Number.isFinite(d?.year) ? d.year : (d?.year ?? null),
		journal: d?.journal ?? d?.journal_name ?? d?.venue ?? null,
		snippet: d?.abstract ?? d?.claim ?? d?.finding ?? d?.snippet ?? null,
		doi: d?.doi ?? null,
		url: d?.url ?? d?.link ?? null,
	};
}

/** A tools/call result can carry its payload as `structuredContent` (MCP
 * 2025-06-18) or as JSON/plain text inside `content[0].text` — try both. */
function toolPayload(result: any): unknown {
	if (result?.structuredContent !== undefined) return result.structuredContent;
	const content = Array.isArray(result?.content) ? result.content : [];
	const textPart = content.find((c: any) => c?.type === "text" && typeof c.text === "string");
	if (!textPart) return null;
	try {
		return JSON.parse(textPart.text);
	} catch {
		return textPart.text;
	}
}

function papersArrayFrom(payload: unknown): any[] {
	if (Array.isArray(payload)) return payload;
	if (payload && typeof payload === "object") {
		for (const key of ["results", "papers", "items", "data"]) {
			const v = (payload as Record<string, unknown>)[key];
			if (Array.isArray(v)) return v;
		}
	}
	return [];
}

export interface ConsensusSearchArgs {
	query: string;
	year_min?: number;
	year_max?: number;
	study_types?: string[];
	limit?: number;
}

export interface ConsensusSearchResult {
	count: number;
	results: ConsensusPaper[];
}

/** initialize + tools/call("search") against Consensus's streamable-HTTP MCP
 * endpoint, given a bearer token — a 401 at either step is reported via
 * `status: 401` rather than thrown, so consensusSearch can self-heal once. */
async function runSearch(token: string, args: ConsensusSearchArgs): Promise<{ status: number; result?: ConsensusSearchResult }> {
	const init = await mcpCall(token, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sux", version: "1.0" } });
	if (init.status === 401) return { status: 401 };
	if (init.status >= 400) throw new Error(`Consensus MCP initialize HTTP ${init.status}`);
	if (init.json?.error) throw new Error(`Consensus MCP initialize failed: ${init.json.error?.message ?? "unknown error"}`);
	await mcpCall(token, null, "notifications/initialized", {}, init.sessionId);

	const toolArgs: Record<string, unknown> = { query: args.query };
	if (args.year_min !== undefined) toolArgs.year_min = args.year_min;
	if (args.year_max !== undefined) toolArgs.year_max = args.year_max;
	if (args.study_types !== undefined) toolArgs.study_types = args.study_types;
	if (args.limit !== undefined) toolArgs.limit = args.limit;
	const call = await mcpCall(token, 2, "tools/call", { name: "search", arguments: toolArgs }, init.sessionId);
	if (call.status === 401) return { status: 401 };
	if (call.status >= 400) throw new Error(`Consensus MCP search HTTP ${call.status}`);
	if (call.json?.error) throw new Error(`Consensus MCP search failed: ${call.json.error?.message ?? "unknown error"}`);
	if (!call.json) throw new Error("Consensus MCP search returned an empty response body.");

	const papers = papersArrayFrom(toolPayload(call.json?.result)).map(normPaper);
	return { status: call.status, result: { count: papers.length, results: papers } };
}

/** The `consensus` fn's one entry point: run a search, self-healing ONCE on a 401
 * (drop the cached access token, re-mint from the refresh grant) — same pattern
 * as mychartFetch's 401 self-heal. Throws when unauthorized even after refresh, or
 * on any other upstream/JSON-RPC failure; the caller (fns/consensus.ts) turns that
 * into a failWith. */
export async function consensusSearch(env: RtEnv, args: ConsensusSearchArgs): Promise<ConsensusSearchResult> {
	const first = await runSearch(await accessToken(env), args);
	if (first.result) return first.result;
	await env.OAUTH_KV?.delete(ACCESS_TOKEN_KEY).catch(() => {});
	const second = await runSearch(await mintAccessToken(env), args);
	if (second.result) return second.result;
	throw new Error("Consensus MCP request unauthorized (HTTP 401) even after a token refresh.");
}

// ---------------- Public routes ----------------

/** GET /consensus/connect + GET /consensus/callback. Served BEFORE the
 * OAuthProvider claims every path (same pre-gate trick as /mychart/connect|
 * callback). `/connect` is Bearer-gated by the operator SUX_CRON_TOKEN (matching
 * /mychart/connect, /admin/tick, /apple-health) so a stranger can't bind THEIR
 * Consensus account to the Worker. */
export async function handleConsensusRoutes(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;

	if (url.pathname === "/consensus/connect") {
		const gate = env.SUX_CRON_TOKEN;
		if (!gate) return new Response("not found", { status: 404 });
		const authHeader = request.headers.get("authorization") ?? "";
		const presented = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
		if (!presented || !timingSafeEqual(gate, presented)) return new Response("unauthorized", { status: 401 });
		try {
			const clientId = await consensusClientId(env);
			const verifier = makeVerifier();
			const challenge = await challengeFor(verifier);
			const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
			await env.OAUTH_KV?.put(pkceKey(state), JSON.stringify({ verifier, created: Date.now() }), { expirationTtl: PKCE_TTL_S });
			const auth = new URL(AUTHORIZE_URL);
			auth.searchParams.set("response_type", "code");
			auth.searchParams.set("client_id", clientId);
			auth.searchParams.set("redirect_uri", redirectUri(env));
			auth.searchParams.set("scope", SCOPES);
			auth.searchParams.set("state", state);
			auth.searchParams.set("code_challenge", challenge);
			auth.searchParams.set("code_challenge_method", "S256");
			return new Response(null, { status: 302, headers: { location: auth.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" } });
		} catch (e) {
			return new Response(escapeHtml(String((e as Error)?.message ?? e)), { status: 502, headers: TEXT_HEADERS });
		}
	}

	if (url.pathname === "/consensus/callback") {
		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state") ?? "";
		const err = url.searchParams.get("error");
		if (err) return new Response(`Consensus authorization error: ${err}`, { status: 400, headers: TEXT_HEADERS });
		if (!code || !state) return new Response("Missing code/state.", { status: 400, headers: PAGE_HEADERS });
		const stored = await env.OAUTH_KV?.get(pkceKey(state));
		if (!stored) return new Response("Invalid or expired state (CSRF check failed).", { status: 400, headers: PAGE_HEADERS });
		await env.OAUTH_KV?.delete(pkceKey(state)).catch(() => {}); // one-time.
		let verifier = "";
		try {
			verifier = JSON.parse(stored)?.verifier ?? "";
		} catch {}
		if (!verifier) return new Response("Corrupt PKCE state.", { status: 400, headers: PAGE_HEADERS });
		try {
			const clientId = await consensusClientId(env);
			const { status, json } = await tokenPost({ grant_type: "authorization_code", code, redirect_uri: redirectUri(env), code_verifier: verifier, client_id: clientId });
			if (status >= 400 || !json?.access_token) {
				return new Response(`Token exchange failed: HTTP ${status} ${json?.error_description ?? json?.error ?? ""}`.trim(), { status: 502, headers: TEXT_HEADERS });
			}
			if (typeof json.refresh_token === "string" && json.refresh_token) {
				const grant: ConsensusGrant = { refresh_token: json.refresh_token, scope: json.scope, issued_at: Date.now() };
				await env.OAUTH_KV?.put(GRANT_KEY, JSON.stringify(grant));
			}
			await cacheAccessToken(env, String(json.access_token), json.expires_in);
			const hasRefresh = Boolean(json.refresh_token);
			return new Response(
				`<!doctype html><meta charset=utf-8><title>Consensus connected</title><body style="font-family:system-ui;padding:2rem"><h1>Consensus connected</h1><p>Your Consensus Pro account is linked.${hasRefresh ? "" : " <strong>No refresh token was issued</strong> — searches will need re-login once the access token expires."}</p><p>You can close this tab.</p></body>`,
				{ status: 200, headers: PAGE_HEADERS },
			);
		} catch (e) {
			return new Response(`Consensus callback failed: ${escapeHtml(String((e as Error)?.message ?? e))}`, { status: 502, headers: TEXT_HEADERS });
		}
	}

	return null;
}
