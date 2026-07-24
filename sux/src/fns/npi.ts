import { type Fn, fail, ok } from "../registry";
import { oj } from "./_util";

// NPPES NPI Registry API v2.1 (npiregistry.cms.hhs.gov/api) — keyless, free CMS lookup
// of US healthcare providers/organizations by NPI number, name, location, or taxonomy.
// No residential proxy: a public government API with no bot wall.

const API = "https://npiregistry.cms.hhs.gov/api/";

function normProvider(r: any): Record<string, unknown> {
	const basic = r?.basic ?? {};
	const name = basic.organization_name ?? ([basic.first_name, basic.last_name].filter(Boolean).join(" ") || null);
	const addr = Array.isArray(r?.addresses) ? r.addresses.find((a: any) => a?.address_purpose === "LOCATION") ?? r.addresses[0] : null;
	const taxonomies = Array.isArray(r?.taxonomies) ? r.taxonomies : [];
	const primaryTaxonomy = taxonomies.find((t: any) => t?.primary) ?? taxonomies[0] ?? null;
	return {
		npi: r?.number ? String(r.number) : null,
		type: r?.enumeration_type === "NPI-2" ? "organization" : "individual",
		name,
		status: basic.status ?? null,
		specialty: primaryTaxonomy?.desc ?? null,
		city: addr?.city ?? null,
		state: addr?.state ?? null,
		postal_code: addr?.postal_code ?? null,
		phone: addr?.telephone_number ?? null,
	};
}

export const npi: Fn = {
	name: "npi",
	description:
		"Look up / search the NPPES NPI Registry (keyless, free CMS API) — US healthcare providers and organizations by NPI number, name, location, or taxonomy/specialty. Provide any combination of `number`, `first_name`, `last_name`, `organization_name`, `taxonomy_description`, `city`, `state`. Returns normalized JSON { count, results:[{ npi, type, name, status, specialty, city, state, postal_code, phone }] }. Tune with `limit` (default 10, max 200, per NPPES's own cap).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			number: { type: "string", description: "A specific 10-digit NPI to look up." },
			first_name: { type: "string" },
			last_name: { type: "string" },
			organization_name: { type: "string" },
			taxonomy_description: { type: "string", description: "Specialty/taxonomy text, e.g. 'Pediatrics'." },
			city: { type: "string" },
			state: { type: "string", description: "Two-letter US state code." },
			limit: { type: "integer", minimum: 1, maximum: 200, default: 10 },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (_env, args) => {
		const number = String(args?.number ?? "").trim();
		const firstName = String(args?.first_name ?? "").trim();
		const lastName = String(args?.last_name ?? "").trim();
		const orgName = String(args?.organization_name ?? "").trim();
		const taxonomy = String(args?.taxonomy_description ?? "").trim();
		const city = String(args?.city ?? "").trim();
		const state = String(args?.state ?? "").trim();
		if (!number && !firstName && !lastName && !orgName && !taxonomy && !(city && state)) {
			return fail("provide at least one of: number, first_name, last_name, organization_name, taxonomy_description, or city+state.");
		}
		const limit = Math.min(200, Math.max(1, Number(args?.limit) || 10));
		const p = new URLSearchParams({ version: "2.1", limit: String(limit) });
		if (number) p.set("number", number);
		if (firstName) p.set("first_name", firstName);
		if (lastName) p.set("last_name", lastName);
		if (orgName) p.set("organization_name", orgName);
		if (taxonomy) p.set("taxonomy_description", taxonomy);
		if (city) p.set("city", city);
		if (state) p.set("state", state);

		let resp: Response;
		try {
			resp = await fetch(`${API}?${p}`, { signal: AbortSignal.timeout(20_000) });
		} catch (e) {
			return fail(`NPI Registry fetch failed: ${String((e as Error)?.message ?? e)}`);
		}
		if (!resp.ok) return fail(`NPI Registry API HTTP ${resp.status}.`);
		const j: any = await resp.json();
		const results = (j?.results ?? []).map(normProvider);
		return ok(oj({ count: results.length, results }));
	},
};
