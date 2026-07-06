import { type Fn, fail, ok } from "../registry";

export const url_parse: Fn = {
	name: "url_parse",
	description:
		"Parse a URL into its parts using the URL standard. Returns JSON { protocol, host, hostname, port, pathname, search, query, hash, origin }. Fails on an invalid URL.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute URL to parse, e.g. 'https://user:pass@host:8080/path?a=1#frag'." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const raw = String(args?.url ?? "").trim();
		if (!raw) return fail("Provide a `url`.");
		let u: URL;
		try {
			u = new URL(raw);
		} catch {
			return fail(`Invalid URL: ${raw}`);
		}
		const query: Record<string, string | string[]> = {};
		for (const [k, v] of u.searchParams) {
			if (k in query) {
				const cur = query[k];
				query[k] = Array.isArray(cur) ? [...cur, v] : [cur as string, v];
			} else {
				query[k] = v;
			}
		}
		return ok(
			JSON.stringify(
				{
					protocol: u.protocol,
					host: u.host,
					hostname: u.hostname,
					port: u.port,
					pathname: u.pathname,
					search: u.search,
					query,
					hash: u.hash,
					origin: u.origin,
				},
				null,
				2,
			),
		);
	},
};
