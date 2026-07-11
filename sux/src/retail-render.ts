// Resilient render for the retailer fns: try the Mac backend first, fall back to
// Cloudflare Browser Rendering (residential + stealth) when it's down.
//
// The Mac node is primary because it has the best track record against active bot
// walls and owns the solver tiers the cf path CANNOT replicate — the PerimeterX
// press-and-hold gesture and the CapSolver captcha tier. But when the node is
// off/502/circuit-open, a mac-only retailer fn fails outright. cf-residential is a
// PROVEN fallback for at least Amazon's AWS WAF (verified live), and worst-case it
// matches today's behavior since it only fires AFTER mac has already failed.
//
// Whichever backend answers, the caller runs the SAME extractor on the returned
// HTML (the extractors are backend-agnostic). Never throws — if BOTH fail we
// surface the mac error, the more informative signal and the message callers match.

import { cfRender } from "./cf-render";
import { type MacRenderResult, macRender } from "./mac-render";
import type { RtEnv } from "./registry";

// The retail callers only ever want post-JS HTML, so this is the mac spec minus
// `as` (always html). `solve` is honored on the mac leg (cf has no solver tier).
export type RetailRenderSpec = {
	url: string;
	wait_until?: string;
	wait_ms?: number;
	block_resources?: boolean;
	timeout_ms?: number;
	solve?: boolean;
};

/**
 * Render a retail page with a mac→cf fallback. Returns the same never-throw
 * envelope as `macRender` ({ ok, contentType, body } | { ok:false, error }) so
 * callers switch to it with no other change. The cf leg forces residential+stealth
 * (its only shot at a bot wall) and reuses the caller's wait/timeout/block knobs.
 */
export async function retailRender(env: RtEnv, spec: RetailRenderSpec): Promise<MacRenderResult> {
	const primary = await macRender(env, { as: "html", ...spec });
	if (primary.ok) return primary;

	const fallback = await cfRender(env, {
		url: spec.url,
		as: "html",
		wait_until: spec.wait_until,
		wait_ms: spec.wait_ms,
		block_resources: spec.block_resources,
		timeout_ms: spec.timeout_ms,
		residential: true,
		stealth: true,
	});
	// cf's html result carries a string `body`; hand it back in the mac envelope.
	if (fallback.ok && "body" in fallback) {
		return { ok: true, contentType: fallback.contentType, body: fallback.body };
	}
	// Both backends down — the mac error is the primary, more actionable signal.
	return primary;
}
