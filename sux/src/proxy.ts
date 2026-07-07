import { githubAuthHeaders } from "./github-auth";

export type TailscaleEnv = {

	TAILSCALE_PROXY_URL?: string;

	TAILSCALE_PROXY_SECRET?: string;

	TAILSCALE_PROXY_ALL?: string;

	GITHUB_TOKEN?: string;
};

export type ProxiedResponse = {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	bytes: number;
	truncated: boolean;
	body: string;

	bodyEncoding?: "base64" | "utf8";
};

export function isTailscaleConfigured(env: TailscaleEnv): boolean {
	return Boolean(env.TAILSCALE_PROXY_URL && env.TAILSCALE_PROXY_SECRET);
}

export async function hmacHex(secret: string, msg: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
	return Array.from(new Uint8Array(sig))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function proxyEnabled(env: TailscaleEnv): boolean {
	return isTailscaleConfigured(env) && env.TAILSCALE_PROXY_ALL !== "0";
}

const DIRECT_HOST_RE = /(^|\.)(?:kagi\.com|cloudflare-dns\.com|dns\.google|ipwho\.is|ip-api\.com)$/i;

export function isDirectHost(url: string): boolean {
	try {
		return DIRECT_HOST_RE.test(new URL(url).hostname);
	} catch {
		return false;
	}
}

export type Route = "auto" | "proxy" | "direct";

const TRANSIENT_STATUS = new Set([408, 429, 502, 503, 504]);

function isTransientStatus(status: number): boolean {
	return TRANSIENT_STATUS.has(status);
}

const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 8_000;

export function backoffDelay(attempt: number, retryAfter?: string | null): number {
	const ra = retryAfter != null ? Number(retryAfter) : Number.NaN;
	if (Number.isFinite(ra) && ra >= 0) return Math.min(ra * 1000, MAX_DELAY_MS);
	const ceil = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
	return Math.round(ceil / 2 + Math.random() * (ceil / 2));
}

async function withRetry(fn: () => Promise<Response>): Promise<Response> {
	let lastResp: Response | undefined;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		if (attempt > 0) await new Promise((r) => setTimeout(r, backoffDelay(attempt - 1, lastResp?.headers.get("retry-after"))));
		try {
			const resp = await fn();
			if (!isTransientStatus(resp.status)) return resp;
			lastResp = resp;
		} catch (e) {
			if (attempt === MAX_ATTEMPTS - 1) throw e;
			lastResp = undefined;
		}
	}
	return lastResp ?? fn();
}

export type FetchRoute = "proxied" | "direct" | "proxy_fallback" | "binary_refetch";

let routeTally: Partial<Record<FetchRoute, number>> = {};

function tallyRoute(r: FetchRoute): void {
	routeTally[r] = (routeTally[r] ?? 0) + 1;
}

export function drainRouteTally(): Partial<Record<FetchRoute, number>> {
	const t = routeTally;
	routeTally = {};
	return t;
}

const TEXTUAL_MIME = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/ecmascript",
	"application/x-www-form-urlencoded",
	"application/x-ndjson",
	"image/svg+xml",
]);

export function isTextualContentType(ct: string | null): boolean {
	const t = (ct ?? "").split(";")[0].trim().toLowerCase();
	if (!t) return true;
	return t.startsWith("text/") || t.endsWith("+json") || t.endsWith("+xml") || TEXTUAL_MIME.has(t);
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes;
}

function proxiedToResponse(p: ProxiedResponse): Response {
	const headers = new Headers(p.headers);

	headers.delete("content-encoding");
	headers.delete("content-length");
	const body = p.bodyEncoding === "base64" ? base64ToBytes(p.body) : p.body;

	return new Response([204, 205, 304].includes(p.status) ? null : body, { status: p.status, statusText: p.statusText, headers });
}

export function willProxy(env: TailscaleEnv, url: string, route: Route = "auto"): boolean {
	if (route === "direct") return false;
	if (!proxyEnabled(env)) return false;
	if (route === "proxy") return true;
	return !isDirectHost(url);
}

export async function smartFetch(
	env: TailscaleEnv,
	url: string,
	init: { method?: string; headers?: Headers | Record<string, string>; body?: string; redirect?: "follow" | "manual" | "error" } = {},
	route: Route = "auto",
): Promise<Response> {

	const ghAuth = githubAuthHeaders(env, url);
	let directRoute: FetchRoute = "direct";
	if (willProxy(env, url, route)) {
		try {
			const callerHeaders = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers ?? {});
			const headers = { ...ghAuth, ...callerHeaders };
			const p = await fetchViaTailscale(env, url, { method: init.method, headers, body: init.body, redirect: init.redirect });
			if (p.bodyEncoding === "base64" || isTextualContentType(new Headers(p.headers).get("content-type"))) {
				tallyRoute("proxied");
				return proxiedToResponse(p);
			}

			directRoute = "binary_refetch";
			console.warn(`smartFetch: proxy returned a stringly binary body for ${url} — refetching direct for byte fidelity`);
		} catch (e) {
			directRoute = "proxy_fallback";
			console.warn(`smartFetch: proxy failed, falling back to direct — ${String((e as Error).message ?? e)}`);
		}
	}
	tallyRoute(directRoute);
	const callerHeaders = init.headers instanceof Headers ? Object.fromEntries(init.headers) : (init.headers ?? {});
	const headers = { ...ghAuth, ...callerHeaders };

	return withRetry(() => fetch(url, { method: init.method, headers, body: init.body, redirect: init.redirect, signal: AbortSignal.timeout(30_000) }));
}

export async function fetchViaTailscale(
	env: TailscaleEnv,
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number; redirect?: "follow" | "manual" | "error" },
): Promise<ProxiedResponse> {
	if (!isTailscaleConfigured(env)) {
		throw new Error("Tailscale proxy not configured (TAILSCALE_PROXY_URL / TAILSCALE_PROXY_SECRET).");
	}

	const endpoint = new URL("/fetch", env.TAILSCALE_PROXY_URL).href;

	const payload = JSON.stringify({ url, method: init?.method, headers: init?.headers, body: init?.body, redirect: init?.redirect, acceptBodyEncoding: "base64" });

	const ts = String(Date.now());
	const signature = await hmacHex(env.TAILSCALE_PROXY_SECRET!, `${ts}\n${payload}`);

	const signedEndpoint = `${endpoint}?ts=${ts}&sig=${signature}`;
	const resp = await fetch(signedEndpoint, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-timestamp": ts,
			"x-signature": signature,
		},
		body: payload,
		signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000),
	});

	if (!resp.ok) {
		const detail = await resp.text().catch(() => "");
		throw new Error(`Tailscale proxy error: HTTP ${resp.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
	}
	return (await resp.json()) as ProxiedResponse;
}

export async function fetchPageViaTailscale(env: TailscaleEnv, url: string, init?: Parameters<typeof fetchViaTailscale>[2]): Promise<Response> {
	return proxiedToResponse(await fetchViaTailscale(env, url, init));
}
