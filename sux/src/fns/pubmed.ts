import { type Fn, fail, ok } from "../registry";

// Lean wrapper over NCBI E-utilities (PubMed). The raw esearch+esummary JSON is
// huge and awkward (two calls, nested articleids, uid maps); this distills it to
// a numbered, citable list — the "compressed private wrapper" pattern.
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export const pubmed: Fn = {
	name: "pubmed",
	description:
		"Search PubMed biomedical literature (NCBI E-utilities), distilled to a numbered, citable list — title, authors, journal, year, PMID, DOI. Cite by PMID. A lean wrapper over the verbose esearch+esummary API.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "PubMed query, e.g. \"crispr off-target 2023\" or field-tagged \"asthma[Title]\"." },
			limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const query = String(args?.query ?? "").trim();
		if (!query) return fail("query is required.");
		const limit = Math.min(Math.max(Number(args?.limit) || 10, 1), 50);

		const esearch = `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&term=${encodeURIComponent(query)}`;
		const sr = await fetch(esearch);
		if (!sr.ok) return fail(`PubMed esearch failed: HTTP ${sr.status}`);
		const ids: string[] = (((await sr.json()) as any)?.esearchresult?.idlist ?? []).slice(0, limit);
		if (!ids.length) return ok(`No PubMed results for "${query}".`);

		const esummary = `${EUTILS}/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}`;
		const mr = await fetch(esummary);
		if (!mr.ok) return fail(`PubMed esummary failed: HTTP ${mr.status}`);
		const result = ((await mr.json()) as any)?.result ?? {};

		const lines = ids.map((id, i) => {
			const d = result[id] ?? {};
			const authors = (d.authors ?? []).map((a: any) => a.name).filter(Boolean);
			const who = authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.join(", ");
			const year = String(d.sortpubdate ?? d.pubdate ?? "").slice(0, 4);
			const doi = (d.articleids ?? []).find((a: any) => a.idtype === "doi")?.value;
			return [
				`${i + 1}. ${d.title ?? "(untitled)"}`,
				`   ${who || "—"} · ${d.fulljournalname ?? d.source ?? "—"}${year ? ` (${year})` : ""}`,
				`   PMID ${id}${doi ? ` · doi:${doi}` : ""} · https://pubmed.ncbi.nlm.nih.gov/${id}/`,
			].join("\n");
		});
		return ok(`PubMed — ${ids.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`);
	},
};
