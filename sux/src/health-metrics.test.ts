import { describe, expect, it } from "vitest";
import { deriveMetrics } from "./github-handler";
import { applyEvent, emptyMetrics } from "./metrics";

describe("deriveMetrics (health cache & routing figures)", () => {
	it("returns nulls (not NaN) on an empty/cold-isolate metrics blob", () => {
		expect(deriveMetrics(emptyMetrics(0))).toEqual({
			calls: 0,
			cache_hit_rate: null,
			residential_ratio: null,
			error_rate: null,
			proxied: 0,
			route_total: 0,
		});
	});

	it("computes cache_hit_rate = cache_hits/total and error_rate = errors/total", () => {
		const m = emptyMetrics(0);
		applyEvent(m, { tool: "scrape", ms: 10 });
		applyEvent(m, { tool: "scrape", ms: 10, cache: true });
		applyEvent(m, { tool: "scrape", ms: 10, cache: true });
		applyEvent(m, { tool: "scrape", ms: 10, error: true, err: "boom" });
		const d = deriveMetrics(m);
		expect(d.calls).toBe(4);
		expect(d.cache_hit_rate).toBe(0.5);
		expect(d.error_rate).toBe(0.25);
	});

	it("computes residential_ratio = routes.proxied / sum(all routes), 4-dp rounded", () => {
		const m = emptyMetrics(0);
		m.routes = { proxied: 1, direct: 1, proxy_fallback: 1 };
		const d = deriveMetrics(m);
		expect(d.proxied).toBe(1);
		expect(d.route_total).toBe(3);
		expect(d.residential_ratio).toBe(0.3333);
	});

	it("guards a zero route tally with null (no fetches recorded yet)", () => {
		const m = emptyMetrics(0);
		m.total = 5;
		const d = deriveMetrics(m);
		expect(d.residential_ratio).toBeNull();
		expect(d.route_total).toBe(0);
	});
});
