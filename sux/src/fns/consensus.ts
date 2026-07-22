import { type Fn, fail, failWith, ok, type RtEnv } from "../registry";
import { consensusSearch, hasConsensusGrant } from "../consensus";
import { errMsg, oj } from "./_util";

// Consensus.app academic search (Pro tier via OAuth) — the sux-native search
// surface over 200M+ papers, MCP JSON-RPC under the hood. The OAuth machinery +
// the /consensus/connect|callback routes live in src/consensus.ts; this fn is the
// headless surface over the resulting refresh grant, same split as mychart
// (src/mychart.ts vs src/fns/mychart.ts). Inert (not_configured) until the
// one-time /consensus/connect login completes — no env var/secret gates this: it's
// a public OAuth client, and dynamic client registration mints its own client_id
// into KV on first connect.

const NOT_CONFIGURED = "Consensus not connected. Open /consensus/connect once (operator bearer required) to link your Consensus Pro account. Read-only.";

export const consensus: Fn = {
	name: "consensus",
	cost: 2,
	cacheable: true,
	ttl: 1800,
	annotations: { readOnlyHint: true, openWorldHint: true },
	description:
		"Consensus.app academic search (Pro tier, 200M+ papers) — natural-language claim/topic search over the scientific literature, normalized to { count, results:[{ title, authors[], year, journal, snippet, doi, url }] }. Provide `query`; narrow with `year_min`/`year_max`/`study_types` (e.g. ['RCT','Meta-analysis']). `limit` caps results (default 10, max 20 — Consensus Pro's per-search cap). Needs a one-time /consensus/connect login (operator bearer); absent → not_configured.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Natural-language research question or claim to search." },
			year_min: { type: "integer", description: "Only papers published on/after this year." },
			year_max: { type: "integer", description: "Only papers published on/before this year." },
			study_types: { type: "array", items: { type: "string" }, description: "Narrow to these study types (e.g. 'RCT', 'Meta-analysis', 'Systematic review')." },
			limit: { type: "integer", minimum: 1, maximum: 20, default: 10 },
		},
	},
	run: async (env: RtEnv, args: any) => {
		const query = String(args?.query ?? "").trim();
		if (!query) return fail("query is required.");
		if (!(await hasConsensusGrant(env))) return failWith("not_configured", NOT_CONFIGURED);
		const limit = Math.min(20, Math.max(1, Number(args?.limit) || 10));
		try {
			const result = await consensusSearch(env, {
				query,
				year_min: Number.isFinite(args?.year_min) ? Number(args.year_min) : undefined,
				year_max: Number.isFinite(args?.year_max) ? Number(args.year_max) : undefined,
				study_types: Array.isArray(args?.study_types) ? args.study_types.map(String) : undefined,
				limit,
			});
			return ok(oj(result));
		} catch (e) {
			return failWith("upstream_error", `Consensus search failed: ${errMsg(e)}`);
		}
	},
};
