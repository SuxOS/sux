import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";
import { extractRpcFromText } from "../mcp-util";
import { fromB64, toB64 } from "./_util";

// Work with Obsidian markdown notes across three backends:
//   git    (default) — a git-backed vault via the GitHub API (async, versioned).
//   remote          — Obsidian's official Local REST API exposed over a PUBLIC
//                     HTTPS URL (Tailscale Funnel), authed with the plugin's
//                     bearer key. The cloud Worker can reach a Funnel URL
//                     directly, so this is real-time to the LIVE vault with no
//                     SSRF issue (the funnel host is public, not LAN).
//   local           — the same Local REST API on localhost/LAN; the Worker can't
//                     reach it and the node SSRF guard blocks LAN IPs, so it's a
//                     stub pointing at `remote`.
const GH = "https://api.github.com";
const ghHeaders = { Accept: "application/vnd.github+json", "User-Agent": "sux-obsidian" };

async function ghJson(env: any, url: string, init?: { method?: string; body?: string }): Promise<{ status: number; json: any }> {
	const resp = await smartFetch(env, url, { method: init?.method, headers: { ...ghHeaders, ...(init?.body ? { "Content-Type": "application/json" } : {}) }, body: init?.body });
	const json = await resp.json().catch(() => null);
	return { status: resp.status, json };
}

// --- KV read-through cache (git = truth, KV = cache) ---
// Git-backend reads validate against the vault's HEAD commit sha (rechecked with
// GitHub at most once a minute); git writes warm the cache in-line, since the
// contents API hands back the new commit sha — which IS the new HEAD. Remote
// reads write through so that when the Mac is asleep, `read` serves the last
// known copy instead of failing. The cache never feeds writes: edit/append
// always re-read their source.
const CACHE_HEAD = "cache:vault:head";
const HEAD_RECHECK_MS = 60_000;
const noteKey = (p: string) => `cache:vault:note:${p.replace(/^\/+/, "")}`;
const listKey = (d: string) => `cache:vault:list:${d.replace(/^\/+/, "") || "/"}`;

async function cacheGet(env: any, key: string): Promise<any | null> {
	try {
		const raw = await env.OAUTH_KV?.get(key);
		return raw ? JSON.parse(raw) : null;
	} catch {
		return null;
	}
}
async function cachePut(env: any, key: string, value: unknown): Promise<void> {
	try {
		await env.OAUTH_KV?.put(key, JSON.stringify(value));
	} catch {}
}
async function cacheDel(env: any, key: string): Promise<void> {
	try {
		await env.OAUTH_KV?.delete(key);
	} catch {}
}

async function vaultHead(env: any, repo: string, branch: string): Promise<string | null> {
	const cached = await cacheGet(env, CACHE_HEAD);
	if (cached?.sha && Date.now() - cached.at < HEAD_RECHECK_MS) return cached.sha;
	const { status, json } = await ghJson(env, `${GH}/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
	const sha = status === 200 ? (json?.object?.sha ?? null) : null;
	if (sha) await cachePut(env, CACHE_HEAD, { sha, at: Date.now() });
	return sha ?? cached?.sha ?? null;
}

async function noteWritten(env: any, path: string, body: string | null, commitSha: string | null | undefined): Promise<void> {
	if (body !== null && commitSha) await cachePut(env, noteKey(path), { body, sha: commitSha, at: Date.now(), src: "git" });
	else await cacheDel(env, noteKey(path));
	if (commitSha) await cachePut(env, CACHE_HEAD, { sha: commitSha, at: Date.now() });
	else await cacheDel(env, CACHE_HEAD);
}

// Surgical find/replace: the match must be unique unless all=true, so an edit
// can never land somewhere unintended — task ops flip exactly the checkbox they
// mean to, and a note is never reprinted wholesale.
function applyEdit(text: string, find: string, replace: string, all: boolean): { text: string; count: number } | { error: string } {
	const count = text.split(find).length - 1;
	if (count === 0) return { error: "`find` text not found" };
	if (count > 1 && !all) return { error: `\`find\` matches ${count} times — pass all:true to replace every occurrence, or make it unique` };
	return { text: all ? text.split(find).join(replace) : text.replace(find, replace), count };
}

// --- remote backend: Obsidian Local REST API over a public HTTPS (Funnel) URL ---
function remoteFetch(env: any, path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
	const base = String(env.OBSIDIAN_REMOTE_URL).replace(/\/+$/, "");
	// Direct fetch: it's your own Funnel'd endpoint — no need to residentially proxy it.
	return fetch(`${base}${path}`, {
		method: init?.method ?? "GET",
		headers: { Authorization: `Bearer ${env.OBSIDIAN_REMOTE_KEY}`, ...(init?.headers ?? {}) },
		body: init?.body,
		signal: AbortSignal.timeout(20_000),
	});
}

const encPath = (p: string) => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");

// The Local REST API plugin ALSO ships a built-in MCP server at /mcp/ (Streamable
// HTTP, Bearer auth) exposing ~15 vault tools. Wrap it (F13). Unlike Kagi's
// stateless MCP, this server is STATEFUL: it requires the MCP handshake —
// initialize (which returns an Mcp-Session-Id header), then notifications/
// initialized, then the real call — all carrying the session id. We run the
// handshake per call (sessions are cheap; keeps the wrapper stateless).
async function obsidianMcp(env: any, method: string, params: unknown): Promise<{ result?: any; error?: any }> {
	const endpoint = `${String(env.OBSIDIAN_REMOTE_URL).replace(/\/+$/, "")}/mcp/`;
	const base = { Authorization: `Bearer ${env.OBSIDIAN_REMOTE_KEY}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
	const post = (sid: string | undefined, payload: unknown) =>
		fetch(endpoint, { method: "POST", headers: { ...base, ...(sid ? { "Mcp-Session-Id": sid } : {}) }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });

	const init = await post(undefined, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "sux", version: "1" } } });
	if (!init.ok) return { error: { message: `MCP initialize HTTP ${init.status}: ${(await init.text().catch(() => "")).slice(0, 160)}` } };
	const sid = init.headers.get("mcp-session-id") ?? undefined;
	if (sid) await post(sid, { jsonrpc: "2.0", method: "notifications/initialized" }).catch(() => {});

	const resp = await post(sid, { jsonrpc: "2.0", id: 2, method, params });
	const obj = extractRpcFromText(await resp.text(), resp.headers.get("content-type"));
	return { result: obj?.result, error: obj?.error ?? (resp.status >= 400 ? { message: `HTTP ${resp.status}` } : undefined) };
}

async function runRemote(env: any, action: string, args: any) {
	if (!env.OBSIDIAN_REMOTE_URL || !env.OBSIDIAN_REMOTE_KEY) {
		return fail("Obsidian remote backend not configured. Set OBSIDIAN_REMOTE_URL (the Tailscale-Funnel'd Local REST API URL, e.g. https://vault.<tailnet>.ts.net) and OBSIDIAN_REMOTE_KEY (the plugin's API key from Obsidian → Local REST API settings).");
	}
	try {
		// Wrap the vault's built-in MCP server (full 15-tool surface).
		if (action === "tools") {
			const { result, error } = await obsidianMcp(env, "tools/list", {});
			if (error) return fail(`Obsidian MCP tools/list error: ${error.message ?? JSON.stringify(error)}`);
			const tools = (result?.tools ?? []).map((t: any) => ({ name: t?.name, description: t?.description }));
			return ok(JSON.stringify({ via: "mcp", count: tools.length, tools }, null, 2));
		}
		if (action === "call") {
			const tool = String(args?.tool ?? "").trim();
			if (!tool) return fail("action=call requires a `tool` (the MCP tool name — run action=tools to list them) and optional `tool_args`.");
			const { result, error } = await obsidianMcp(env, "tools/call", { name: tool, arguments: args?.tool_args ?? {} });
			if (error) return fail(`Obsidian MCP '${tool}' error: ${error.message ?? JSON.stringify(error)}`);
			const text = (result?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("\n");
			if (result?.isError) return fail(text || `Obsidian MCP '${tool}' returned an error.`);
			return ok(text || JSON.stringify(result, null, 2));
		}
		if (action === "list") {
			const dir = String(args?.path ?? "").replace(/^\/+|\/+$/g, "");
			const resp = await remoteFetch(env, `/vault/${dir ? `${encPath(dir)}/` : ""}`);
			if (resp.status >= 400) return fail(`Obsidian remote error listing: HTTP ${resp.status}`);
			const j = (await resp.json().catch(() => null)) as any;
			const files = j?.files ?? [];
			return ok(JSON.stringify({ dir: dir || "/", count: files.length, files }, null, 2));
		}
		if (action === "read") {
			const p = String(args?.path ?? "").trim();
			if (!p) return fail("action=read requires a `path`.");
			let resp: Response;
			try {
				resp = await remoteFetch(env, `/vault/${encPath(p)}`, { headers: { Accept: "text/markdown" } });
			} catch (e) {
				// Mac asleep / Funnel down: serve the last KV-cached copy over failing.
				const hit = await cacheGet(env, noteKey(p));
				if (typeof hit?.body === "string") return ok(hit.body);
				return fail(`obsidian remote unreachable (${String((e as Error).message ?? e)}) and no cached copy of ${p} — try backend:'git'.`);
			}
			if (resp.status === 404) return fail(`Note not found: ${p}`);
			if (resp.status >= 400) return fail(`Obsidian remote error reading: HTTP ${resp.status}`);
			const text = await resp.text();
			await cachePut(env, noteKey(p), { body: text, sha: null, at: Date.now(), src: "remote" });
			return ok(text);
		}
		if (action === "search") {
			const q = String(args?.query ?? "").trim();
			if (!q) return fail("action=search requires a `query`.");
			const resp = await remoteFetch(env, `/search/simple/?query=${encodeURIComponent(q)}&contextLength=100`, { method: "POST" });
			if (resp.status >= 400) return fail(`Obsidian remote search error: HTTP ${resp.status}`);
			const j = (await resp.json().catch(() => null)) as any;
			const hits = (Array.isArray(j) ? j : []).slice(0, 20).map((h: any) => ({ path: h?.filename, score: h?.score }));
			return ok(JSON.stringify({ query: q, count: hits.length, hits }, null, 2));
		}
		if (action === "append") {
			const p = String(args?.path ?? "").trim();
			const content = String(args?.content ?? "");
			if (!p) return fail("action=append requires a `path`.");
			if (!content) return fail("action=append requires `content`.");
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "POST", headers: { "Content-Type": "text/markdown" }, body: content });
			if (resp.status >= 400) return fail(`Obsidian remote write error: HTTP ${resp.status}`);
			await cacheDel(env, noteKey(p)); // merged body lives server-side; next read refills
			return ok(JSON.stringify({ ok: true, path: p, bytes: content.length }, null, 2));
		}
		if (action === "write") {
			const p = String(args?.path ?? "").trim();
			const content = String(args?.content ?? "");
			if (!p) return fail("action=write requires a `path`.");
			if (!content) return fail("action=write requires `content`.");
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "PUT", headers: { "Content-Type": "text/markdown" }, body: content });
			if (resp.status >= 400) return fail(`Obsidian remote write error: HTTP ${resp.status}`);
			await cachePut(env, noteKey(p), { body: content, sha: null, at: Date.now(), src: "remote" });
			return ok(JSON.stringify({ ok: true, path: p, bytes: content.length }, null, 2));
		}
		if (action === "edit") {
			const p = String(args?.path ?? "").trim();
			const find = String(args?.find ?? "");
			if (!p) return fail("action=edit requires a `path`.");
			if (!find) return fail("action=edit requires `find` (the exact text to replace).");
			const cur = await remoteFetch(env, `/vault/${encPath(p)}`, { headers: { Accept: "text/markdown" } });
			if (cur.status === 404) return fail(`Note not found: ${p}`);
			if (cur.status >= 400) return fail(`Obsidian remote error reading: HTTP ${cur.status}`);
			const edited = applyEdit(await cur.text(), find, String(args?.replace ?? ""), args?.all === true);
			if ("error" in edited) return fail(`${edited.error} in ${p}`);
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "PUT", headers: { "Content-Type": "text/markdown" }, body: edited.text });
			if (resp.status >= 400) return fail(`Obsidian remote write error: HTTP ${resp.status}`);
			await cachePut(env, noteKey(p), { body: edited.text, sha: null, at: Date.now(), src: "remote" });
			return ok(JSON.stringify({ ok: true, path: p, replaced: edited.count }, null, 2));
		}
		if (action === "delete") {
			const p = String(args?.path ?? "").trim();
			if (!p) return fail("action=delete requires a `path`.");
			const resp = await remoteFetch(env, `/vault/${encPath(p)}`, { method: "DELETE" });
			if (resp.status === 404) return fail(`Note not found: ${p}`);
			if (resp.status >= 400) return fail(`Obsidian remote delete error: HTTP ${resp.status}`);
			await cacheDel(env, noteKey(p));
			return ok(JSON.stringify({ ok: true, deleted: p }, null, 2));
		}
		return fail(`Unknown action '${action}'. Use list | read | search | append | write | edit | delete | tools | call.`);
	} catch (e) {
		return fail(`obsidian remote (${action}) failed: ${String((e as Error).message ?? e)}`);
	}
}

export const obsidian: Fn = {
	name: "obsidian",
	cost: 2,
	description:
		"Work with Obsidian markdown notes. action: list (notes, optionally under `path`) | read (a note by `path`) | search (`query`) | append (add `content` to a note at `path`, creating it if absent) | write (create/overwrite a note with `content`) | edit (surgical find/replace: `find` + `replace`, unique match unless `all`) | delete (remove a note). backend: git (default) — a GitHub-backed vault; every write is a commit, so git history is the undo (OBSIDIAN_VAULT_REPO='owner/repo', optional OBSIDIAN_VAULT_BRANCH/OBSIDIAN_VAULT_DIR; GITHUB_TOKEN for private repos + writes); remote — the LIVE vault via Obsidian's Local REST API over a public HTTPS URL (Tailscale Funnel; OBSIDIAN_REMOTE_URL + OBSIDIAN_REMOTE_KEY). remote also wraps the vault's built-in MCP server: action=tools lists its ~15 vault tools and action=call runs one (tool + tool_args). local — same API on localhost, unreachable from the cloud Worker (use remote). Reads are KV-cached: git reads validate against the vault HEAD sha; remote reads write through and fall back to the cached copy when the Mac is unreachable.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["action"],
		properties: {
			action: { type: "string", enum: ["list", "read", "search", "append", "write", "edit", "delete", "tools", "call"] },
			path: { type: "string", description: "Note path within the vault (read/append/write/edit/delete; a folder filter for list)." },
			query: { type: "string", description: "Search query (action=search)." },
			content: { type: "string", description: "Markdown content (action=append/write)." },
			find: { type: "string", description: "Exact text to replace (action=edit); must match exactly once unless `all` is set." },
			replace: { type: "string", description: "Replacement text (action=edit; empty string deletes the match)." },
			all: { type: "boolean", description: "Replace every occurrence of `find` (action=edit)." },
			tool: { type: "string", description: "MCP tool name (remote, action=call). Run action=tools to list them." },
			tool_args: { type: "object", additionalProperties: true, description: "Arguments for the MCP tool (remote, action=call)." },
			backend: { type: "string", enum: ["git", "remote", "local"], default: "git" },
		},
	},
	cacheable: false, // notes are mutable; reads should reflect the live vault
	run: async (env, args) => {
		const action = String(args?.action ?? "");
		const backend = String(args?.backend ?? "git");
		if (backend === "remote") return runRemote(env, action, args);
		if (backend === "local") {
			return fail("backend:'local' (Obsidian Local REST API over the tailnet) isn't wired yet — expose the Local REST API over Tailscale Funnel and use backend:'remote' (OBSIDIAN_REMOTE_URL + OBSIDIAN_REMOTE_KEY), or use the git backend.");
		}
		const repo = env.OBSIDIAN_VAULT_REPO;
		if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) return fail("Obsidian git backend not configured. Set OBSIDIAN_VAULT_REPO to 'owner/repo'.");
		const branch = String(env.OBSIDIAN_VAULT_BRANCH ?? "main");
		const dir = String(env.OBSIDIAN_VAULT_DIR ?? "").replace(/^\/+|\/+$/g, "");
		const inVault = (p: string) => (dir ? `${dir}/${p}`.replace(/\/+/g, "/") : p);

		try {
			if (action === "list") {
				const filter = args?.path ? inVault(String(args.path)) : dir;
				const head = env.OAUTH_KV ? await vaultHead(env, repo, branch) : null;
				if (head) {
					const hit = await cacheGet(env, listKey(filter));
					if (hit?.sha === head && typeof hit.payload === "string") return ok(hit.payload);
				}
				const { status, json } = await ghJson(env, `${GH}/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
				if (status >= 400) return fail(`GitHub error listing vault: ${json?.message ?? `HTTP ${status}`}`);
				const notes = (json?.tree ?? [])
					.filter((n: any) => n?.type === "blob" && typeof n.path === "string" && n.path.endsWith(".md") && (!filter || n.path.startsWith(filter)))
					.map((n: any) => n.path);
				const payload = JSON.stringify({ repo, branch, count: notes.length, notes }, null, 2);
				if (head) await cachePut(env, listKey(filter), { payload, sha: head, at: Date.now() });
				return ok(payload);
			}
			if (action === "read") {
				const p = String(args?.path ?? "").trim();
				if (!p) return fail("action=read requires a `path`.");
				const head = env.OAUTH_KV ? await vaultHead(env, repo, branch) : null;
				if (head) {
					const hit = await cacheGet(env, noteKey(p));
					if (hit?.sha === head && typeof hit.body === "string") return ok(hit.body);
				}
				const { status, json } = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(inVault(p))}?ref=${encodeURIComponent(branch)}`);
				if (status === 404) return fail(`Note not found: ${p}`);
				if (status >= 400) return fail(`GitHub error reading note: ${json?.message ?? `HTTP ${status}`}`);
				const text = json?.content ? new TextDecoder().decode(fromB64(String(json.content).replace(/\n/g, ""))) : "";
				if (head) await cachePut(env, noteKey(p), { body: text, sha: head, at: Date.now(), src: "git" });
				return ok(text);
			}
			if (action === "search") {
				const q = String(args?.query ?? "").trim();
				if (!q) return fail("action=search requires a `query`.");
				const { status, json } = await ghJson(env, `${GH}/search/code?q=${encodeURIComponent(`${q} repo:${repo} extension:md`)}&per_page=20`);
				if (status >= 400) return fail(`GitHub search error: ${json?.message ?? `HTTP ${status}`} (code search needs an authenticated GITHUB_TOKEN).`);
				const hits = (json?.items ?? []).map((it: any) => ({ path: it?.path, url: it?.html_url }));
				return ok(JSON.stringify({ query: q, count: hits.length, hits }, null, 2));
			}
			if (action === "append") {
				const p = String(args?.path ?? "").trim();
				const content = String(args?.content ?? "");
				if (!p) return fail("action=append requires a `path`.");
				if (!content) return fail("action=append requires `content`.");
				const full = inVault(p);
				// Read current (for the sha + existing body); 404 → create fresh.
				const cur = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(branch)}`);
				const existing = cur.status === 200 && cur.json?.content ? new TextDecoder().decode(fromB64(String(cur.json.content).replace(/\n/g, ""))) : "";
				const sha = cur.status === 200 ? cur.json?.sha : undefined;
				const merged = existing ? `${existing.replace(/\n+$/, "")}\n\n${content}\n` : `${content}\n`;
				const body = JSON.stringify({ message: `sux: append to ${p}`, content: toB64(new TextEncoder().encode(merged)), branch, ...(sha ? { sha } : {}) });
				const put = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}`, { method: "PUT", body });
				if (put.status >= 400) return fail(`GitHub write error: ${put.json?.message ?? `HTTP ${put.status}`} (append needs a GITHUB_TOKEN with write access).`);
				await noteWritten(env, p, merged, put.json?.commit?.sha);
				return ok(JSON.stringify({ ok: true, path: p, bytes: merged.length, commit: put.json?.commit?.sha }, null, 2));
			}
			if (action === "write") {
				const p = String(args?.path ?? "").trim();
				const content = String(args?.content ?? "");
				if (!p) return fail("action=write requires a `path`.");
				if (!content) return fail("action=write requires `content`.");
				const full = inVault(p);
				const cur = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(branch)}`);
				const sha = cur.status === 200 ? cur.json?.sha : undefined;
				const body = JSON.stringify({ message: `sux: write ${p}`, content: toB64(new TextEncoder().encode(content)), branch, ...(sha ? { sha } : {}) });
				const put = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}`, { method: "PUT", body });
				if (put.status >= 400) return fail(`GitHub write error: ${put.json?.message ?? `HTTP ${put.status}`} (write needs a GITHUB_TOKEN with write access).`);
				await noteWritten(env, p, content, put.json?.commit?.sha);
				return ok(JSON.stringify({ ok: true, path: p, bytes: content.length, created: cur.status === 404, commit: put.json?.commit?.sha }, null, 2));
			}
			if (action === "edit") {
				const p = String(args?.path ?? "").trim();
				const find = String(args?.find ?? "");
				if (!p) return fail("action=edit requires a `path`.");
				if (!find) return fail("action=edit requires `find` (the exact text to replace).");
				const full = inVault(p);
				const cur = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(branch)}`);
				if (cur.status === 404) return fail(`Note not found: ${p}`);
				if (cur.status >= 400) return fail(`GitHub error reading note: ${cur.json?.message ?? `HTTP ${cur.status}`}`);
				const existing = cur.json?.content ? new TextDecoder().decode(fromB64(String(cur.json.content).replace(/\n/g, ""))) : "";
				const edited = applyEdit(existing, find, String(args?.replace ?? ""), args?.all === true);
				if ("error" in edited) return fail(`${edited.error} in ${p}`);
				const body = JSON.stringify({ message: `sux: edit ${p}`, content: toB64(new TextEncoder().encode(edited.text)), branch, sha: cur.json?.sha });
				const put = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}`, { method: "PUT", body });
				if (put.status >= 400) return fail(`GitHub write error: ${put.json?.message ?? `HTTP ${put.status}`} (edit needs a GITHUB_TOKEN with write access).`);
				await noteWritten(env, p, edited.text, put.json?.commit?.sha);
				return ok(JSON.stringify({ ok: true, path: p, replaced: edited.count, commit: put.json?.commit?.sha }, null, 2));
			}
			if (action === "delete") {
				const p = String(args?.path ?? "").trim();
				if (!p) return fail("action=delete requires a `path`.");
				const full = inVault(p);
				const cur = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}?ref=${encodeURIComponent(branch)}`);
				if (cur.status === 404) return fail(`Note not found: ${p}`);
				if (cur.status >= 400) return fail(`GitHub error reading note: ${cur.json?.message ?? `HTTP ${cur.status}`}`);
				const body = JSON.stringify({ message: `sux: delete ${p}`, sha: cur.json?.sha, branch });
				const del = await ghJson(env, `${GH}/repos/${repo}/contents/${encodeURIComponent(full)}`, { method: "DELETE", body });
				if (del.status >= 400) return fail(`GitHub delete error: ${del.json?.message ?? `HTTP ${del.status}`} (delete needs a GITHUB_TOKEN with write access).`);
				await noteWritten(env, p, null, del.json?.commit?.sha);
				return ok(JSON.stringify({ ok: true, deleted: p, commit: del.json?.commit?.sha }, null, 2));
			}
			return fail(`Unknown action '${action}'. Use list | read | search | append | write | edit | delete.`);
		} catch (e) {
			return fail(`obsidian (${action}) failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
