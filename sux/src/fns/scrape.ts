import { type Fn, failWith, ok } from "../registry";
import { smartFetch } from "../proxy";
import { clamp, isHttpUrl, noCacheOn4xx, noCacheOnMutation } from "./_util";

export const scrape: Fn = {
	name: "scrape",
	description:
		"Fetch a web page through the residential proxy (falls back to direct) and return its raw content. Use for pages that block datacenter IPs. Parsing happens in the cloud.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
			method: { type: "string", default: "GET" },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!isHttpUrl(url)) return failWith("bad_input", "Provide an absolute http(s) url.");
		const resp = await smartFetch(env, url, { method: args?.method });
		const body = await resp.text();
		// clamp (not a bare slice): appends the truncation marker so the model knows
		// the page was cut at the cap rather than silently ending mid-content.
		return noCacheOnMutation(noCacheOn4xx(ok(`HTTP ${resp.status} — ${url}\n\n${clamp(body)}`), resp.status), args?.method);
	},
};
