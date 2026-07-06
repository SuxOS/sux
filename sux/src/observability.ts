// Public, unauthenticated observability endpoints for the sux engine:
//   GET /health   — liveness + config sanity (for uptime monitors)
//   GET /metrics  — usage metrics as JSON (?format=prometheus for scraping)
//   GET /logs     — rolling call log with metric fields (JSON; ?tool= / ?limit= )
// No dashboard UI by design — logging + metrics only. Returns null when the path
// isn't ours so index.ts can fall through to OAuth.

import { FUNCTIONS } from "./fns";
import { readMetrics, toPrometheus } from "./metrics";
import type { RtEnv } from "./registry";
import { isTailscaleConfigured } from "./proxy";

const json = (obj: unknown, status = 200): Response =>
	new Response(JSON.stringify(obj, null, 2), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handleObservability(url: URL, request: Request, env: RtEnv): Promise<Response | null> {
	if (request.method !== "GET") return null;

	if (url.pathname === "/health") {
		return json({
			status: "ok",
			service: "sux",
			time: new Date().toISOString(),
			functions: FUNCTIONS.length,
			bindings: {
				kv: Boolean(env.OAUTH_KV),
				ai: Boolean(env.AI),
				rate_limiter: Boolean(env.MCP_RATE_LIMITER),
				residential_proxy: isTailscaleConfigured(env),
			},
		});
	}

	if (url.pathname === "/metrics") {
		const m = await readMetrics(env);
		if (url.searchParams.get("format") === "prometheus") {
			return new Response(toPrometheus(m), { status: 200, headers: { "content-type": "text/plain; version=0.0.4", "cache-control": "no-store" } });
		}
		// Metrics view excludes the rolling log (see /logs) to stay compact.
		const { recent, ...summary } = m;
		return json(summary);
	}

	if (url.pathname === "/logs") {
		const m = await readMetrics(env);
		const tool = url.searchParams.get("tool");
		const limit = Math.min(Number(url.searchParams.get("limit")) || 50, m.recent.length);
		let recent = m.recent;
		if (tool) recent = recent.filter((e) => e.tool === tool);
		return json({
			since: m.since,
			total: m.total,
			cache_hits: m.cache_hits,
			errors: m.errors,
			recent: recent.slice(0, limit).map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
		});
	}

	return null;
}
