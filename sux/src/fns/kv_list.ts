import { type Fn, ok } from "../registry";

const NS = "kv:";

export const kv_list: Fn = {
	name: "kv_list",
	description: "List keys in the KV store. Params: prefix (optional, matched against user keys). Lists only the 'kv:' namespace and returns JSON { keys: [...] } with the 'kv:' prefix stripped from display.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: [],
		properties: {
			prefix: { type: "string", description: "Optional prefix filter, applied to user keys (without the internal 'kv:' prefix)." },
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const userPrefix = typeof args?.prefix === "string" ? args.prefix.trim() : "";
		const fullPrefix = NS + userPrefix;

		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await env.OAUTH_KV.list({ prefix: fullPrefix, cursor });
			for (const k of page.keys) keys.push(k.name.slice(NS.length));
			cursor = page.list_complete ? undefined : page.cursor;
		} while (cursor);

		keys.sort();
		return ok(JSON.stringify({ keys }, null, 2));
	},
};
