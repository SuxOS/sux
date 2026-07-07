import { type Fn, fail, ok } from "../registry";

// LinkedIn data via Proxycurl (nubela.co) — LinkedIn's own API has no general
// people/company lookup, so a people-data provider is the practical path.
// Key-gated on PROXYCURL_API_KEY. This is a connector-wrap (F13): Proxycurl's
// person/company payloads are huge, so we distill them to a few token-cheap
// fields. Authenticated API → egresses direct, bounded with a timeout.
const PROXYCURL = "https://nubela.co/proxycurl/api";

function distillPerson(j: any): Record<string, unknown> {
	return {
		full_name: j?.full_name,
		headline: j?.headline,
		occupation: j?.occupation,
		location: [j?.city, j?.state, j?.country_full_name].filter(Boolean).join(", ") || undefined,
		summary: j?.summary,
		current: (j?.experiences ?? []).slice(0, 3).map((e: any) => ({ title: e?.title, company: e?.company, starts_at: e?.starts_at?.year })),
		education: (j?.education ?? []).slice(0, 3).map((e: any) => ({ school: e?.school, degree: e?.degree_name, field: e?.field_of_study })),
		skills: (j?.skills ?? []).slice(0, 15),
		connections: j?.connections,
		profile_url: j?.public_identifier ? `https://www.linkedin.com/in/${j.public_identifier}` : undefined,
	};
}

function distillCompany(j: any): Record<string, unknown> {
	return {
		name: j?.name,
		industry: j?.industry,
		description: j?.description,
		website: j?.website,
		size: j?.company_size_on_linkedin,
		founded_year: j?.founded_year,
		followers: j?.follower_count,
		hq: j?.hq ? [j.hq.city, j.hq.state, j.hq.country].filter(Boolean).join(", ") : undefined,
		specialities: (j?.specialities ?? []).slice(0, 10),
	};
}

export const linkedin: Fn = {
	name: "linkedin",
	cost: 3,
	description:
		"LinkedIn data via Proxycurl (people-data provider). action: person (default) resolves a profile URL to a distilled profile (name, headline, current roles, education, skills); company resolves a company URL to firmographics. `url` is the linkedin.com profile/company URL. Needs PROXYCURL_API_KEY (nubela.co/proxycurl). Distills Proxycurl's verbose payload to a few token-cheap fields.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "A linkedin.com profile or company URL." },
			action: { type: "string", enum: ["person", "company"], default: "person" },
		},
	},
	cacheable: true,
	ttl: 86400, // profiles change slowly; Proxycurl calls cost credits — cache hard
	run: async (env, args) => {
		const apiKey = env.PROXYCURL_API_KEY;
		if (!apiKey) return fail("LinkedIn not configured (PROXYCURL_API_KEY). Get a key at https://nubela.co/proxycurl.");
		const url = String(args?.url ?? "").trim();
		if (!/^https?:\/\/([\w-]+\.)*linkedin\.com\//i.test(url)) return fail("`url` must be a linkedin.com profile or company URL.");
		const action = String(args?.action ?? "person") === "company" ? "company" : "person";
		const endpoint =
			action === "company"
				? `${PROXYCURL}/linkedin/company?url=${encodeURIComponent(url)}`
				: `${PROXYCURL}/v2/linkedin?linkedin_profile_url=${encodeURIComponent(url)}`;
		try {
			const resp = await fetch(endpoint, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
			const j = (await resp.json().catch(() => null)) as any;
			if (!resp.ok) return fail(`Proxycurl error: ${j?.description ?? j?.detail ?? `HTTP ${resp.status}`}`);
			return ok(JSON.stringify(action === "company" ? distillCompany(j) : distillPerson(j), null, 2));
		} catch (e) {
			return fail(`linkedin failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
