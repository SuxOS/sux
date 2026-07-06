import { type Fn, fail, ok } from "../registry";

// Lean wrapper over the ClinicalTrials.gov v2 API. The raw study records are
// enormous (deeply nested protocolSection/derivedSection); this distills each to
// the fields that matter for triage — NCT id, title, status, phase, conditions,
// enrollment, dates — as a numbered, citable list.
const API = "https://clinicaltrials.gov/api/v2/studies";

export const clinical_trials: Fn = {
	name: "clinical_trials",
	description:
		"Search ClinicalTrials.gov, distilled to a numbered list — NCT id, title, status, phase, conditions, enrollment, start date. Optional status filter (RECRUITING, COMPLETED, …). A lean wrapper over the verbose v2 API.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Condition/intervention terms, e.g. \"glioblastoma car-t\"." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
			status: { type: "string", description: "Optional overall-status filter, e.g. RECRUITING | COMPLETED | TERMINATED." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const query = String(args?.query ?? "").trim();
		if (!query) return fail("query is required.");
		const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50);

		const p = new URLSearchParams({ "query.term": query, pageSize: String(limit), format: "json" });
		if (args?.status) p.set("filter.overallStatus", String(args.status).toUpperCase());
		const r = await fetch(`${API}?${p}`);
		if (!r.ok) return fail(`ClinicalTrials.gov failed: HTTP ${r.status}`);
		const studies: any[] = (((await r.json()) as any)?.studies ?? []).slice(0, limit);
		if (!studies.length) return ok(`No trials for "${query}".`);

		const lines = studies.map((s, i) => {
			const ps = s.protocolSection ?? {};
			const id = ps.identificationModule?.nctId ?? "?";
			const title = ps.identificationModule?.briefTitle ?? "(untitled)";
			const status = ps.statusModule?.overallStatus ?? "—";
			const start = ps.statusModule?.startDateStruct?.date ?? "";
			const phase = (ps.designModule?.phases ?? []).join("/") || "N/A";
			const enroll = ps.designModule?.enrollmentInfo?.count;
			const conds = (ps.conditionsModule?.conditions ?? []).slice(0, 3).join(", ");
			return [
				`${i + 1}. ${title}`,
				`   ${id} · ${status} · phase ${phase}${enroll ? ` · n=${enroll}` : ""}${start ? ` · ${start}` : ""}`,
				`   ${conds || "—"} · https://clinicaltrials.gov/study/${id}`,
			].join("\n");
		});
		return ok(`ClinicalTrials.gov — ${studies.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`);
	},
};
