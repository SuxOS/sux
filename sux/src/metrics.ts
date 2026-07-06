// Lightweight usage metrics for the sux engine. Aggregated in a single KV key
// (read-modify-write, best-effort via ctx.waitUntil) — good enough for a
// dashboard at low/medium volume. NOT strongly consistent: concurrent writers
// can lose an increment. If precise counts ever matter, move to a Durable Object.

import type { RtEnv } from "./registry";

const KEY = "sux:metrics";
const TTL = 60 * 60 * 24 * 30; // 30 days

export type ToolStat = { calls: number; errors: number; cache_hits: number; total_ms: number };
export type LogEntry = { at: number; tool: string; ms: number; cache: boolean; error: boolean };
export type Metrics = {
	since: number;
	total: number;
	cache_hits: number;
	errors: number;
	tools: Record<string, ToolStat>;
	recent: LogEntry[]; // rolling log (newest first), capped
};

const RECENT_CAP = 50;

export function emptyMetrics(now: number): Metrics {
	return { since: now, total: 0, cache_hits: 0, errors: 0, tools: {}, recent: [] };
}

export async function readMetrics(env: RtEnv): Promise<Metrics> {
	const raw = await env.OAUTH_KV.get(KEY);
	if (raw) {
		try {
			const m = JSON.parse(raw) as Metrics;
			if (!Array.isArray(m.recent)) m.recent = []; // migrate older records
			return m;
		} catch {
			/* fall through to fresh */
		}
	}
	return emptyMetrics(Date.now());
}

export type CallEvent = { tool: string; ms: number; cache?: boolean; error?: boolean; at?: number };

/** Fold one tool call into the aggregate + rolling log. Pure — easy to unit-test. */
export function applyEvent(m: Metrics, e: CallEvent): Metrics {
	const t = (m.tools[e.tool] ??= { calls: 0, errors: 0, cache_hits: 0, total_ms: 0 });
	m.total++;
	t.calls++;
	t.total_ms += e.ms || 0;
	if (e.cache) {
		m.cache_hits++;
		t.cache_hits++;
	}
	if (e.error) {
		m.errors++;
		t.errors++;
	}
	m.recent.unshift({ at: e.at ?? 0, tool: e.tool, ms: e.ms || 0, cache: Boolean(e.cache), error: Boolean(e.error) });
	if (m.recent.length > RECENT_CAP) m.recent.length = RECENT_CAP;
	return m;
}

/**
 * Record a call: emits a structured log line (Workers Logs) AND folds it into the
 * KV-backed metrics/rolling-log — all best-effort, off the response path.
 */
export function recordCall(env: RtEnv, ctx: { waitUntil(p: Promise<unknown>): void }, e: CallEvent): void {
	const at = Date.now();
	// The single structured log line (queryable in Workers Logs / wrangler tail).
	console.log(`sux ${JSON.stringify({ tool: e.tool, ms: e.ms, cache: Boolean(e.cache), error: Boolean(e.error), at })}`);
	ctx.waitUntil(
		(async () => {
			const m = applyEvent(await readMetrics(env), { ...e, at });
			await env.OAUTH_KV.put(KEY, JSON.stringify(m), { expirationTtl: TTL });
		})().catch(() => {}),
	);
}

/** Prometheus text exposition (text/plain; version=0.0.4). */
export function toPrometheus(m: Metrics): string {
	const lines: string[] = [
		"# HELP sux_calls_total Total tool calls.",
		"# TYPE sux_calls_total counter",
		`sux_calls_total ${m.total}`,
		"# HELP sux_cache_hits_total Total cache hits.",
		"# TYPE sux_cache_hits_total counter",
		`sux_cache_hits_total ${m.cache_hits}`,
		"# HELP sux_errors_total Total tool errors.",
		"# TYPE sux_errors_total counter",
		`sux_errors_total ${m.errors}`,
		"# HELP sux_tool_calls_total Per-tool call count.",
		"# TYPE sux_tool_calls_total counter",
	];
	for (const [name, t] of Object.entries(m.tools)) {
		lines.push(`sux_tool_calls_total{tool="${name}"} ${t.calls}`);
	}
	lines.push("# HELP sux_tool_errors_total Per-tool error count.", "# TYPE sux_tool_errors_total counter");
	for (const [name, t] of Object.entries(m.tools)) {
		lines.push(`sux_tool_errors_total{tool="${name}"} ${t.errors}`);
	}
	lines.push("# HELP sux_tool_latency_ms_avg Per-tool average latency (ms).", "# TYPE sux_tool_latency_ms_avg gauge");
	for (const [name, t] of Object.entries(m.tools)) {
		lines.push(`sux_tool_latency_ms_avg{tool="${name}"} ${t.calls ? Math.round(t.total_ms / t.calls) : 0}`);
	}
	return `${lines.join("\n")}\n`;
}
