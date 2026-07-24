import { type Fn, fail, ok } from "../registry";
import { oj } from "./_util";

// CMS Coverage API v1 (api.coverage.cms.gov) — keyless, free Medicare coverage-policy
// search: National Coverage Determinations (NCDs) and Local Coverage Determinations
// (LCDs). No residential proxy: a public government API with no bot wall. Every field
// is read defensively (optional-chained, `?? null`) since CMS's own response envelope
// isn't versioned as strictly as NCBI/ClinicalTrials.gov — a shape drift degrades to
// nulls rather than a crash.

const API = "https://api.coverage.cms.gov/v1/reports";

function normPolicy(d: any, kind: "ncd" | "lcd"): Record<string, unknown> {
	return {
		kind,
		id: d?.documentDisplayId ?? d?.id ?? null,
		title: d?.documentTitle ?? d?.title ?? null,
		status: d?.status ?? null,
		effective_date: d?.effectiveDate ?? null,
		url: d?.documentDisplayId ? `https://www.cms.gov/medicare-coverage-database/view/${kind}.aspx?${kind}id=${d.documentDisplayId}` : null,
	};
}

export const cms_coverage: Fn = {
	name: "cms_coverage",
	description:
		"Search the CMS Medicare Coverage Database (keyless, free) — National Coverage Determinations (NCDs) and Local Coverage Determinations (LCDs) for Medicare Part B coverage policy. Provide `keyword` (procedure, condition, or policy text). Returns normalized JSON { count, results:[{ kind, id, title, status, effective_date, url }] }. `kind` selects 'ncd' (default) or 'lcd'. Tune with `limit` (default 10, max 100).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["keyword"],
		properties: {
			keyword: { type: "string", description: "Procedure, condition, or policy text to search coverage determinations for." },
			kind: { type: "string", enum: ["ncd", "lcd"], default: "ncd" },
			limit: { type: "integer", minimum: 1, maximum: 100, default: 10 },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (_env, args) => {
		const keyword = String(args?.keyword ?? "").trim();
		if (!keyword) return fail("keyword is required.");
		const kind = args?.kind === "lcd" ? "lcd" : "ncd";
		const limit = Math.min(100, Math.max(1, Number(args?.limit) || 10));
		const path = kind === "lcd" ? "local-coverage-determinations" : "national-coverage-determinations";
		const p = new URLSearchParams({ keyword, size: String(limit) });

		let resp: Response;
		try {
			resp = await fetch(`${API}/${path}?${p}`, { signal: AbortSignal.timeout(20_000) });
		} catch (e) {
			return fail(`CMS Coverage API fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`CMS Coverage API HTTP ${resp.status}.`);
		const j: any = await resp.json();
		const rows = Array.isArray(j?.data) ? j.data : Array.isArray(j) ? j : [];
		const results = rows.slice(0, limit).map((d: any) => normPolicy(d, kind));
		return ok(oj({ count: results.length, results }));
	},
};
