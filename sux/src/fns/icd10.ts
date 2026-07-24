import { type Fn, fail, ok } from "../registry";
import { oj } from "./_util";

// NLM Clinical Table Search Service — ICD-10-CM (clinicaltables.nlm.nih.gov) —
// keyless, free, static/versioned diagnosis-code lookup. No residential proxy: a
// public NIH endpoint with no bot wall. (ICD-10-PCS procedure codes aren't served by
// this table; scope stays to CM/diagnosis codes, per the issue's own framing.)

const API = "https://clinicaltables.nlm.nih.gov/api/icd10cm/v3/search";

export const icd10: Fn = {
	name: "icd10",
	description:
		"Search / look up ICD-10-CM diagnosis codes (keyless, free NLM Clinical Table Search Service). Provide `term` — a code prefix (e.g. 'E11') or a diagnosis text fragment (e.g. 'type 2 diabetes'). Returns normalized JSON { count, results:[{ code, name }] }. Tune with `max` (default 10, max 500).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["term"],
		properties: {
			term: { type: "string", description: "Code prefix or diagnosis text fragment." },
			max: { type: "integer", minimum: 1, maximum: 500, default: 10 },
		},
	},
	cacheable: true,
	ttl: 86400,
	run: async (_env, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("term is required.");
		const max = Math.min(500, Math.max(1, Number(args?.max) || 10));
		const p = new URLSearchParams({ sf: "code,name", terms: term, maxList: String(max) });

		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`, { signal: AbortSignal.timeout(20_000) });
		} catch (e) {
			return fail(`ICD-10-CM lookup fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`ICD-10-CM lookup API HTTP ${resp.status}.`);
		// Response shape: [total, codes[], extra, display[[code,name],...]] — the NLM
		// Clinical Table Search Service's fixed 4-element array contract (same shape
		// across every table this service serves, not just ICD-10-CM).
		const j: any = await resp.json();
		const display: any[] = Array.isArray(j?.[3]) ? j[3] : [];
		const results = display.map(([code, name]: [string, string]) => ({ code: code ?? null, name: name ?? null }));
		return ok(oj({ count: results.length, results }));
	},
};
