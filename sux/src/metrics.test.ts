import { describe, expect, it } from "vitest";
import { applyEvent, emptyMetrics, toPrometheus } from "./metrics";

describe("metrics", () => {
	it("folds events into per-tool + global aggregates", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "search", ms: 100 });
		applyEvent(m, { tool: "search", ms: 200, cache: true });
		applyEvent(m, { tool: "dns", ms: 50, error: true });

		expect(m.total).toBe(3);
		expect(m.cache_hits).toBe(1);
		expect(m.errors).toBe(1);
		expect(m.tools.search).toEqual({ calls: 2, errors: 0, cache_hits: 1, total_ms: 300 });
		expect(m.tools.dns).toEqual({ calls: 1, errors: 1, cache_hits: 0, total_ms: 50 });
	});

	it("renders Prometheus exposition with per-tool series", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "search", ms: 100 });
		const out = toPrometheus(m);
		expect(out).toContain("sux_calls_total 1");
		expect(out).toContain('sux_tool_calls_total{tool="search"} 1');
		expect(out).toContain('sux_tool_latency_ms_avg{tool="search"} 100');
	});
});
