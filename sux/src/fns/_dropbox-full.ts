import { type RtEnv } from "../registry";
import { toB64 } from "./_util";

// Full-Dropbox (Mode B) client — READ + SEARCH over the WHOLE Dropbox, behind a
// SEPARATE full-scope credential (DROPBOX_FULL_*) at a DISTINCT KV key. This never
// touches the App-folder credential (Mode A stays the /Apps/<app>/ safety wall), and
// it is dormant unless hasDropboxFull(env). Read-only by construction: no upload/move/
// delete lives here — whole-account MUTATION is a deliberate, separately-gated build
// (see docs/proposals/files.md Mode B: the injection-reachable delete/overwrite surface
// needs the vault-mirror guard configured fail-closed first). Design + adversarial
// review: the design-full-dropbox-mode-b workflow.
//
// Auth mirrors dropbox.ts's public-client (PKCE, secretless) refresh: mint a short-lived
// access token from the full refresh token, cache it in KV under a full-only key, and
// self-heal a 401 by re-minting once.

const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";
const OAUTH_TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const FULL_TOKEN_KEY = "sux:dropbox:full:token";

/** Oversize gate: above this, read returns a TEMPORARY (expiring, non-public) link, never bytes. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;
const TEXT_EXT = /\.(md|txt|json|csv|tsv|ya?ml|xml|html?|js|ts|css)$/i;

/** True when the full-Dropbox (Mode B) credential is configured. */
export const hasDropboxFull = (env: RtEnv): boolean =>
	Boolean((env.DROPBOX_FULL_REFRESH_TOKEN && env.DROPBOX_FULL_APP_KEY) || env.DROPBOX_FULL_TOKEN);

const headerSafeJson = (v: unknown): string => JSON.stringify(v).replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

/** Absolute Dropbox path: "" = account root; a file/folder is "/Foo/bar". */
export const normFull = (p: unknown): string => {
	const s = String(p ?? "").trim().replace(/\/+$/g, "").replace(/^\/+/, "");
	return s ? `/${s}` : "";
};

async function mintFull(env: RtEnv): Promise<string> {
	const hasSecret = Boolean(env.DROPBOX_FULL_APP_SECRET);
	const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded" };
	if (hasSecret) headers.Authorization = `Basic ${btoa(`${env.DROPBOX_FULL_APP_KEY}:${env.DROPBOX_FULL_APP_SECRET}`)}`;
	const resp = await fetch(OAUTH_TOKEN_URL, {
		method: "POST",
		headers,
		body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(String(env.DROPBOX_FULL_REFRESH_TOKEN))}${hasSecret ? "" : `&client_id=${encodeURIComponent(String(env.DROPBOX_FULL_APP_KEY))}`}`,
		signal: AbortSignal.timeout(20_000),
	});
	const j: any = await resp.json().catch(() => null);
	if (!resp.ok || !j?.access_token) throw new Error(`Dropbox-full token refresh HTTP ${resp.status}: ${j?.error_description ?? j?.error ?? "no access_token"}`);
	const ttl = Math.max(60, (Number(j?.expires_in) || 14_400) - 60);
	await env.OAUTH_KV?.put(FULL_TOKEN_KEY, String(j.access_token), { expirationTtl: ttl });
	return String(j.access_token);
}

async function fullToken(env: RtEnv): Promise<string> {
	if (env.DROPBOX_FULL_REFRESH_TOKEN && env.DROPBOX_FULL_APP_KEY) {
		const cached = await env.OAUTH_KV?.get(FULL_TOKEN_KEY);
		if (cached) return cached;
		return mintFull(env);
	}
	if (env.DROPBOX_FULL_TOKEN) return String(env.DROPBOX_FULL_TOKEN);
	throw new Error("Full-Dropbox not configured. Set DROPBOX_FULL_REFRESH_TOKEN + DROPBOX_FULL_APP_KEY (+ optional DROPBOX_FULL_APP_SECRET).");
}

/** Fetch with per-credential 401 self-heal (re-mint ONLY the full token, never Mode A's). */
async function fullFetch(env: RtEnv, url: string, build: (t: string) => RequestInit): Promise<Response> {
	const first = await fetch(url, build(await fullToken(env)));
	if (first.status !== 401 || !(env.DROPBOX_FULL_REFRESH_TOKEN && env.DROPBOX_FULL_APP_KEY)) return first;
	await env.OAUTH_KV?.delete(FULL_TOKEN_KEY).catch(() => {});
	return fetch(url, build(await fullToken(env)));
}

async function fullRpc(env: RtEnv, path: string, body: unknown): Promise<{ status: number; json: any }> {
	const resp = await fullFetch(env, `${API}${path}`, (t) => ({
		method: "POST",
		headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	}));
	return { status: resp.status, json: await resp.json().catch(() => null) };
}

const fileEntry = (m: any) => ({ kind: m?.[".tag"], name: m?.name, path: m?.path_display ?? m?.path_lower, size: m?.size, rev: m?.rev, modified: m?.server_modified });

/** Whole-Dropbox search (files/search_v2). Read-only, handles only (never bytes). */
export async function searchFull(env: RtEnv, opts: { query: string; path_prefix?: string; ext?: string[]; max_results?: number; cursor?: string }): Promise<{ matches: any[]; has_more: boolean; cursor?: string }> {
	let r: { status: number; json: any };
	if (opts.cursor) {
		r = await fullRpc(env, "/files/search/continue_v2", { cursor: opts.cursor });
	} else {
		const options: Record<string, unknown> = { max_results: Math.min(1000, Math.max(1, opts.max_results ?? 100)), file_status: "active", filename_only: false };
		if (opts.path_prefix) options.path = normFull(opts.path_prefix); // omit → whole account
		if (opts.ext?.length) options.file_extensions = opts.ext.map((e) => String(e).replace(/^\./, ""));
		r = await fullRpc(env, "/files/search_v2", { query: opts.query, options });
	}
	if (r.status >= 400) throw new Error(`Dropbox search error: ${r.json?.error_summary ?? `HTTP ${r.status}`}`);
	const matches = (r.json?.matches ?? []).map((m: any) => fileEntry(m?.metadata?.metadata)).filter((e: any) => e.path);
	return { matches, has_more: !!r.json?.has_more, cursor: r.json?.has_more ? r.json?.cursor : undefined };
}

/** List an absolute Dropbox folder ("" = account root). Read-only. */
export async function listFull(env: RtEnv, path: string, cursor?: string): Promise<{ entries: any[]; has_more: boolean; cursor?: string }> {
	const r = cursor ? await fullRpc(env, "/files/list_folder/continue", { cursor }) : await fullRpc(env, "/files/list_folder", { path: normFull(path), recursive: false, include_mounted_folders: true, include_non_downloadable_files: false });
	if (r.status >= 400) throw new Error(`Dropbox list error: ${r.json?.error_summary ?? `HTTP ${r.status}`}`);
	return { entries: (r.json?.entries ?? []).map(fileEntry), has_more: !!r.json?.has_more, cursor: r.json?.has_more ? r.json?.cursor : undefined };
}

/** Read one file at an absolute path. Oversize → a TEMPORARY (expiring, NON-public) link, never a permanent share.
 *  ONE reference (the plain path `p`) gates AND downloads — never a rev/id that could point elsewhere. Reading a
 *  specific revision is intentionally NOT supported: it would let the size gate check one object and the download
 *  fetch another, bypassing the oversize cap (adversarial-review: injection-reachable OOM). Mode A `get` is the same. */
export async function readFull(env: RtEnv, path: string): Promise<Record<string, unknown>> {
	const p = normFull(path);
	if (!p) throw new Error("read requires a file path.");
	const meta = await fullRpc(env, "/files/get_metadata", { path: p });
	if (meta.status >= 400) throw new Error(`Dropbox error: ${meta.json?.error_summary ?? `HTTP ${meta.status}`} (${p})`);
	if (meta.json?.[".tag"] === "folder") throw new Error(`'${p}' is a folder — use files_list.`);
	const size = Number(meta.json?.size);
	if (!Number.isFinite(size)) throw new Error(`Dropbox returned no size for '${p}'; refusing an unbounded download.`);
	if (size > MAX_INLINE_BYTES) {
		// TEMPORARY link (expires ~4h, NOT a public share) — a full-scope path must never
		// be turned into a permanent 'anyone with the link' URL (adversarial-review CRITICAL).
		const tl = await fullRpc(env, "/files/get_temporary_link", { path: p });
		if (tl.status >= 400 || !tl.json?.link) throw new Error(`Dropbox temporary-link error: ${tl.json?.error_summary ?? `HTTP ${tl.status}`} (${p})`);
		return { path: meta.json?.path_display ?? p, size, rev: meta.json?.rev, too_large_to_inline: true, temporary_link: tl.json.link, note: "temporary link, expires in ~4h" };
	}
	const resp = await fullFetch(env, `${CONTENT}/files/download`, (t) => ({ method: "POST", headers: { Authorization: `Bearer ${t}`, "Dropbox-API-Arg": headerSafeJson({ path: p }) }, signal: AbortSignal.timeout(60_000) }));
	if (resp.status >= 400) throw new Error(`Dropbox download error: ${(await resp.text().catch(() => "")).slice(0, 200) || `HTTP ${resp.status}`}`);
	const bytes = new Uint8Array(await resp.arrayBuffer());
	const textual = TEXT_EXT.test(p);
	return textual
		? { path: meta.json?.path_display ?? p, size: bytes.length, rev: meta.json?.rev, text: new TextDecoder().decode(bytes) }
		: { path: meta.json?.path_display ?? p, size: bytes.length, rev: meta.json?.rev, base64: toB64(bytes) };
}
