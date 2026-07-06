// OAuth→Bearer reverse proxy for Kagi's hosted MCP server.
//
// claude.ai web + iOS custom connectors speak OAuth only and have no field for a
// static bearer token. Kagi's hosted MCP (https://mcp.kagi.com/mcp) currently
// authenticates with `Authorization: Bearer <API key>` and does NOT support OAuth
// yet. This Worker bridges the gap: workers-oauth-provider terminates Claude's
// OAuth (GitHub login), we gate to a single GitHub account, then transparently
// proxy the MCP JSON-RPC / SSE stream to Kagi with the API key injected
// server-side. Tools (kagi_search_fetch, kagi_extract, and whatever Kagi adds
// later) are entirely Kagi's — this file defines none.
//
// When Kagi ships OAuth, delete this Worker and point Claude at mcp.kagi.com/mcp.

import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "./github-handler";

// KAGI_API_KEY and ALLOWED_GITHUB_LOGIN are set via `wrangler secret put` and are
// not yet in the generated Env type; intersect them in here.
type KagiEnv = Env & {
	KAGI_API_KEY: string;
	ALLOWED_GITHUB_LOGIN: string;
};

// Props stamped onto the token by github-handler.ts (see completeAuthorization).
type Props = {
	login: string;
	name: string;
	email: string;
	accessToken: string;
};

const KAGI_MCP_URL = "https://mcp.kagi.com/mcp";

const kagiProxy = {
	async fetch(
		request: Request,
		env: KagiEnv,
		ctx: ExecutionContext & { props?: Props },
	): Promise<Response> {
		// --- Single-user gate ------------------------------------------------
		// workers-oauth-provider has already validated the OAuth token and put the
		// GitHub identity on ctx.props. Fail closed if it isn't the owner.
		const login = ctx.props?.login?.toLowerCase();
		const allowed = (env.ALLOWED_GITHUB_LOGIN ?? "").toLowerCase();
		if (!login || login !== allowed) {
			return new Response(
				JSON.stringify({
					error: "forbidden",
					detail: `GitHub user "${ctx.props?.login ?? "unknown"}" is not authorized for this connector.`,
				}),
				{ status: 403, headers: { "content-type": "application/json" } },
			);
		}

		// --- Reverse proxy to Kagi's hosted MCP ------------------------------
		const incoming = new URL(request.url);
		const target = KAGI_MCP_URL + incoming.search;

		// Preserve client headers (keeps Accept: application/json, text/event-stream
		// so streamable-HTTP / SSE works), swap in the Kagi key, drop Host.
		const headers = new Headers(request.headers);
		headers.set("Authorization", `Bearer ${env.KAGI_API_KEY}`);
		headers.delete("host");

		const init: RequestInit = {
			method: request.method,
			headers,
			body:
				request.method === "GET" || request.method === "HEAD"
					? undefined
					: request.body,
			// @ts-expect-error - `duplex` is required for streaming request bodies on Workers
			duplex: "half",
		};

		const upstream = await fetch(target, init);

		// Stream Kagi's response (JSON or text/event-stream) straight back.
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: upstream.headers,
		});
	},
};

export default new OAuthProvider({
	apiHandler: kagiProxy as any,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GitHubHandler as any,
	tokenEndpoint: "/token",
});
