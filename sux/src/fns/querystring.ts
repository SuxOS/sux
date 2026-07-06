import { type Fn, fail, ok } from "../registry";

export const querystring: Fn = {
	name: "querystring",
	description:
		"Parse or build a URL query string. direction: parse (default) | build. parse: 'a=1&b=2' (or a full URL) -> JSON object (repeated keys become arrays). build: JSON object -> encoded query string. Returns the result.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { description: "For parse: a query string or full URL. For build: a JSON object of key -> value | value[]." },
			direction: { type: "string", enum: ["parse", "build"], default: "parse" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const direction = String(args?.direction ?? "parse");

		if (direction === "build") {
			const obj = args?.data;
			if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return fail("build: `data` must be a JSON object.");
			const params = new URLSearchParams();
			for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
				if (Array.isArray(v)) for (const item of v) params.append(k, String(item));
				else if (v !== undefined && v !== null) params.append(k, String(v));
			}
			return ok(params.toString());
		}

		if (direction === "parse") {
			const data = String(args?.data ?? "");
			// Accept a full URL (take its query) or a bare query string (optional leading ?).
			let query = data;
			if (/^https?:\/\//i.test(data)) {
				try {
					query = new URL(data).search;
				} catch {
					return fail("parse: `data` looked like a URL but could not be parsed.");
				}
			}
			const params = new URLSearchParams(query.replace(/^\?/, ""));
			const out: Record<string, string | string[]> = {};
			for (const [k, v] of params) {
				if (k in out) {
					const cur = out[k];
					out[k] = Array.isArray(cur) ? [...cur, v] : [cur as string, v];
				} else {
					out[k] = v;
				}
			}
			return ok(JSON.stringify(out, null, 2));
		}

		return fail("direction must be parse | build.");
	},
};
