import type { RtEnv } from "../registry";
import { smartFetch } from "../proxy";

export function isHttpUrl(u: unknown): u is string {
	return typeof u === "string" && /^https?:\/\//i.test(u);
}

export function clamp(s: string, maxBytes = 100_000): string {
	return s.length > maxBytes ? `${s.slice(0, maxBytes)}\n… [truncated at ${maxBytes} bytes]` : s;
}

export function toB64(bytes: Uint8Array): string {
	let s = "";
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(s);
}

export function fromB64(b64: string): Uint8Array {
	const bin = atob(b64.trim());
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export type Fetched = { status: number; text: string; headers: Headers; url: string };

export type FetchCacheEntry = { at: number; status: number; text: string; headers: Record<string, string>; url: string };
const FETCH_CACHE = new Map<string, FetchCacheEntry>();
export const FETCH_CACHE_TTL_MS = 30_000;
export const FETCH_CACHE_MAX_ENTRIES = 64;
export const FETCH_CACHE_MAX_TEXT = 512_000;

let dedupForced: boolean | null = null;
const fetchDedupActive = (): boolean => dedupForced ?? !(typeof process !== "undefined" && process.env?.VITEST);

export function setFetchDedup(on: boolean | null): void {
	dedupForced = on;
}

export function fetchCacheGet(key: string, now: number): FetchCacheEntry | null {
	const e = FETCH_CACHE.get(key);
	if (!e) return null;
	if (now - e.at > FETCH_CACHE_TTL_MS) {
		FETCH_CACHE.delete(key);
		return null;
	}
	return e;
}

export function fetchCacheSet(key: string, e: FetchCacheEntry): void {
	if (FETCH_CACHE.size >= FETCH_CACHE_MAX_ENTRIES && !FETCH_CACHE.has(key)) {
		const oldest = FETCH_CACHE.keys().next().value;
		if (oldest !== undefined) FETCH_CACHE.delete(oldest);
	}
	FETCH_CACHE.set(key, e);
}

export function clearFetchCache(): void {
	FETCH_CACHE.clear();
}

export const FETCH_TEXT_MAX_BYTES = 2_000_000;

async function readBodyText(resp: Response, maxBytes: number): Promise<string> {
	if (!resp.body) return (await resp.text()).slice(0, maxBytes);
	const reader = resp.body.getReader();
	const decoder = new TextDecoder();
	let out = "";
	let consumed = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const keep = Math.min(value.byteLength, maxBytes - consumed);
		consumed += value.byteLength;
		out += decoder.decode(keep === value.byteLength ? value : value.subarray(0, keep), { stream: true });
		if (consumed >= maxBytes) {

			await reader.cancel().catch(() => {});
			return out;
		}
	}
	return out + decoder.decode();
}

export async function fetchText(
	env: RtEnv,
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number },
): Promise<Fetched> {
	const maxBytes = init?.maxBytes ?? FETCH_TEXT_MAX_BYTES;
	const uuid = storeRefUuid(url);
	if (uuid && env.R2) {
		const blob = await getBlob(env, uuid);
		if (!blob) return { status: 404, text: `No stored object for '${uuid}'.`, headers: new Headers(), url };
		const text = new TextDecoder().decode(blob.bytes);
		return { status: 200, text: text.slice(0, maxBytes), headers: new Headers({ "content-type": blob.contentType }), url };
	}

	const method = (init?.method ?? "GET").toUpperCase();
	const dedupKey = fetchDedupActive() && method === "GET" && !init?.body ? `${maxBytes}|${url}` : null;
	if (dedupKey) {
		const hit = fetchCacheGet(dedupKey, Date.now());
		if (hit) return { status: hit.status, text: hit.text, headers: new Headers(hit.headers), url: hit.url };
	}
	const resp = await smartFetch(env, url, { method: init?.method, headers: init?.headers, body: init?.body });
	const text = await readBodyText(resp, maxBytes);

	if (dedupKey && resp.status < 400 && text.length <= FETCH_CACHE_MAX_TEXT) {
		fetchCacheSet(dedupKey, { at: Date.now(), status: resp.status, text, headers: Object.fromEntries(resp.headers), url });
	}
	return { status: resp.status, text, headers: resp.headers, url };
}

export async function fetchTextOk(
	env: RtEnv,
	url: unknown,
	init?: { method?: string; headers?: Record<string, string>; body?: string; maxBytes?: number },
): Promise<{ text: string; headers: Headers; status: number } | { error: string }> {
	if (!isHttpUrl(url)) return { error: "url must be an absolute http(s) URL." };
	let fetched: Fetched;
	try {
		fetched = await fetchText(env, url, init);
	} catch (e) {
		return { error: `Fetch failed: ${String((e as Error).message ?? e)}` };
	}
	if (fetched.status >= 400) return { error: `Fetch failed: HTTP ${fetched.status} for ${url}` };
	return { text: fetched.text, headers: fetched.headers, status: fetched.status };
}

export function noCacheOn4xx<T extends { noCache?: boolean }>(result: T, status: number): T {
	if (status >= 400) result.noCache = true;
	return result;
}

export async function loadBytes(env: RtEnv, src: { url?: string; base64?: string }): Promise<{ bytes: Uint8Array; contentType?: string }> {
	if (typeof src.base64 === "string" && src.base64) return { bytes: fromB64(src.base64) };
	if (!isHttpUrl(src.url)) throw new Error("provide `base64` bytes or an absolute http(s) `url`");
	const url = String(src.url);
	const uuid = storeRefUuid(url);
	if (uuid && env.R2) {
		const blob = await getBlob(env, uuid);
		if (!blob) throw new Error(`No stored object for '${uuid}'.`);
		return blob;
	}
	const resp = await smartFetch(env, url, {});
	if (resp.status >= 400) throw new Error(`Fetch failed: HTTP ${resp.status} for ${url}`);
	return { bytes: new Uint8Array(await resp.arrayBuffer()), contentType: resp.headers.get("content-type") ?? undefined };
}

export async function loadHtml(env: RtEnv, args: any, maxBytes?: number): Promise<{ html: string } | { error: string }> {
	if (typeof args?.html === "string" && args.html) return { html: args.html };
	if (args?.url) {
		const fetched = await fetchTextOk(env, args.url, { maxBytes });
		if ("error" in fetched) return { error: fetched.error };
		return { html: fetched.text };
	}
	return { error: "Provide `html` or `url`." };
}

export function stripHtml(html: string): string {
	return html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\s+/g, " ")
		.trim();
}

export const STORE_KV_PREFIX = "store:";

export function storeBase(env: RtEnv): string {
	const v = (env as { STORE_BASE?: string }).STORE_BASE;
	return (typeof v === "string" && v ? v : "https://sux.colinxs.workers.dev").replace(/\/+$/, "");
}

export function extractStoreId(s: string): string {
	const m = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(s);
	return m ? m[1].toLowerCase() : s.trim();
}

export function storeRefUuid(u: unknown): string | null {
	if (!isHttpUrl(u)) return null;
	try {
		const m = /^\/s\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i.exec(new URL(u).pathname);
		return m ? m[1].toLowerCase() : null;
	} catch {
		return null;
	}
}

export async function getBlob(env: RtEnv, uuid: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
	if (!env.R2) return null;
	const raw = await env.OAUTH_KV.get(`${STORE_KV_PREFIX}${uuid}`);
	if (!raw) return null;
	const ref = JSON.parse(raw) as { key: string; content_type?: string };
	const obj = await env.R2.get(ref.key);
	if (!obj) return null;
	return { bytes: new Uint8Array(await obj.arrayBuffer()), contentType: ref.content_type ?? obj.httpMetadata?.contentType ?? "application/octet-stream" };
}

export type BlobRef = { uuid: string; url: string; key: string; sha256: string; size: number; content_type: string };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(buf))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export async function putBlob(env: RtEnv, bytes: Uint8Array, contentType: string): Promise<BlobRef> {
	if (!env.R2) throw new Error("R2 is not available (bucket binding missing).");
	const sha256 = await sha256Hex(bytes);
	const key = `cas/${sha256}`;
	const uuid = crypto.randomUUID();

	await Promise.all([
		env.R2.put(key, bytes, { httpMetadata: { contentType }, customMetadata: { sha256 } }),
		env.OAUTH_KV.put(`${STORE_KV_PREFIX}${uuid}`, JSON.stringify({ key, content_type: contentType, size: bytes.length, sha256 })),
	]);
	return { uuid, url: `${storeBase(env)}/s/${uuid}`, key, sha256, size: bytes.length, content_type: contentType };
}

export async function deliverBytes(
	env: RtEnv,
	bytes: Uint8Array,
	contentType: string,
	as: string | undefined,
	inline: () => { content: Array<{ type: "text"; text: string }> },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
	if (as === "url") {
		try {
			const ref = await putBlob(env, bytes, contentType);
			return { content: [{ type: "text", text: JSON.stringify({ url: ref.url, sha256: ref.sha256, size: ref.size, content_type: contentType }, null, 2) }] };
		} catch (e) {
			return { content: [{ type: "text", text: `as:"url" needs the R2 store: ${String((e as Error).message ?? e)}` }], isError: true };
		}
	}
	return inline();
}

export function inlineB64(bytes: Uint8Array, mime: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: JSON.stringify({ mime, size: bytes.length, base64: toB64(bytes) }) }] };
}
