import type OAuthProvider from "@cloudflare/workers-oauth-provider";
import { isAllowedLogin } from "./utils";
import { cacheKey, deferCacheWrite, type JsonRpc, parseJsonRpc, sseResponse } from "./mcp-util";
import { unpackFromCache } from "./cache-codec";
import { findFn, type RtEnv, type ToolResult, toolList } from "./registry";
import { singleFlight } from "./single-flight";
import { weightedRateLimit } from "./rate-limit";
import { hasAI, llm } from "./ai";

const SUMMARIZE_MIN_CHARS = 400;
import { FUNCTIONS } from "./fns";
import { recordCall } from "./metrics";
import { handleObservability } from "./observability";
import { normalizeArgs, normalizeText } from "./normalize";

type Props = { login: string; name: string; email: string; accessToken: string };

const inflight = new Map<string, Promise<ToolResult>>();

export async function handleRpc(env: RtEnv, ctx: ExecutionContext, rpc: JsonRpc | undefined): Promise<Response> {
	const method = rpc?.method;
	const id = rpc?.id ?? null;

	if (!method) return new Response(null, { status: 202 });
	if (method === "initialize") {
		return sseResponse({
			jsonrpc: "2.0",
			id,
			result: {
				protocolVersion: "2025-06-18",
				capabilities: { tools: { listChanged: false } },
				serverInfo: { name: "research-tools", version: "0.1.0" },
			},
		});
	}
	if (method.startsWith("notifications/")) return new Response(null, { status: 202 });
	if (method === "tools/list") {
		return sseResponse({ jsonrpc: "2.0", id, result: { tools: toolList(FUNCTIONS) } });
	}
	if (method === "tools/call") {
		const name = rpc?.params?.name ?? "";
		const fn = findFn(FUNCTIONS, name);
		if (!fn) return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } });

		const rawArgs = rpc?.params?.arguments;
		let fresh = false;
		if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && (rawArgs as Record<string, unknown>).fresh) {
			fresh = true;
			delete (rawArgs as Record<string, unknown>).fresh;
		}

		let summarize = false;
		if (rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) && (rawArgs as Record<string, unknown>).summarize) {
			summarize = true;
			delete (rawArgs as Record<string, unknown>).summarize;
		}

		const args = fn.raw ? rawArgs : normalizeArgs(rawArgs);

		const started = Date.now();
		const key = fn.cacheable ? await cacheKey(summarize ? `${name}::summarize` : name, args) : null;
		if (key && !fresh) {

			try {
				const raw = await env.OAUTH_KV.get(key, "arrayBuffer");
				if (raw) {
					recordCall(env, ctx, { tool: name, ms: Date.now() - started, cache: true });
					return sseResponse({ jsonrpc: "2.0", id, result: JSON.parse(unpackFromCache(raw)) });
				}
			} catch (e) {
				console.warn(`sux cache read failed for '${name}', recomputing: ${String((e as Error).message ?? e)}`);
			}
		}
		let result: ToolResult;
		let err: string | undefined;
		try {

			result = key ? await singleFlight(inflight, key, () => fn.run(env, args)) : await fn.run(env, args);
		} catch (e) {
			err = String((e as Error).message ?? e);
			console.error(`sux tool '${name}' threw: ${(e as Error)?.stack ?? err}`);
			result = { content: [{ type: "text" as const, text: `Tool '${name}' failed: ${err}` }], isError: true };
		}

		if (!fn.raw && !result.isError && Array.isArray(result.content)) {
			for (const part of result.content) {
				if (part?.type === "text" && typeof part.text === "string") part.text = normalizeText(part.text);
			}
		}

		if (summarize && !fn.raw && !result.isError && Array.isArray(result.content) && hasAI(env)) {
			const joined = result.content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n");
			if (joined.length >= SUMMARIZE_MIN_CHARS) {
				try {
					const s = await llm(env, "Summarize this tool result as concisely as possible while preserving key facts, names, numbers, dates, and URLs. Output only the summary — no preamble.", joined.slice(0, 24_000), 512);
					if (s.trim()) result = { content: [{ type: "text", text: s.trim() }], ...(result.noCache ? { noCache: true } : {}) };
				} catch (e) {
					console.warn(`sux summarize failed for '${name}', returning raw: ${String((e as Error).message ?? e)}`);
				}
			}
		}

		if (!err && result.isError && Array.isArray(result.content)) {
			const first = result.content.find((p: { type?: string; text?: unknown }) => p?.type === "text" && typeof p.text === "string");
			if (first) err = (first as { text: string }).text;
		}
		recordCall(env, ctx, { tool: name, ms: Date.now() - started, error: Boolean(result.isError), err });

		deferCacheWrite(env.OAUTH_KV, ctx, key, result, fn.ttl);
		return sseResponse({ jsonrpc: "2.0", id, result });
	}
	return sseResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method: ${method}` } });
}

const rtServer = {
	async fetch(request: Request, env: RtEnv, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
		const login = ctx.props?.login;
		if (!isAllowedLogin(login, env.ALLOWED_GITHUB_LOGIN)) {
			console.warn(`gate: rejected login=${JSON.stringify(login ?? null)}`);
			return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } });
		}
		if (env.MCP_RATE_LIMITER) {
			const { success } = await env.MCP_RATE_LIMITER.limit({ key: login! });
			if (!success) return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } });
		}

		const isBodyless = request.method === "GET" || request.method === "HEAD";
		const rpc = parseJsonRpc(isBodyless ? undefined : await request.text());

		const limited = await weightedRateLimit(env, login!, rpc);
		if (limited) return limited;
		return handleRpc(env, ctx, rpc);
	},
};

let oauthProvider: OAuthProvider | undefined;
async function getOAuthProvider(): Promise<OAuthProvider> {
	if (!oauthProvider) {
		const [{ default: OAuthProviderCtor }, { GitHubHandler }] = await Promise.all([
			import("@cloudflare/workers-oauth-provider"),
			import("./github-handler"),
		]);
		oauthProvider = new OAuthProviderCtor({
			apiHandler: rtServer as any,
			apiRoute: "/mcp",
			authorizeEndpoint: "/authorize",
			clientRegistrationEndpoint: "/register",
			defaultHandler: GitHubHandler as any,
			tokenEndpoint: "/token",
		});
	}
	return oauthProvider;
}

export default {
	async fetch(request: Request, env: RtEnv, ctx: ExecutionContext): Promise<Response> {

		const obs = await handleObservability(new URL(request.url), request, env);
		if (obs) return obs;
		try {
			return await (await getOAuthProvider()).fetch(request, env as any, ctx);
		} catch (e) {
			const msg = String((e as Error)?.message ?? e);
			const clientError = /redirect|client|invalid|unauthoriz|unregister|missing|csrf|state/i.test(msg);
			console.error(`oauth wrapper caught: ${msg}`);
			return new Response(JSON.stringify({ error: clientError ? "invalid_request" : "server_error", error_description: msg }), {
				status: clientError ? 400 : 500,
				headers: { "content-type": "application/json" },
			});
		}
	},
};
