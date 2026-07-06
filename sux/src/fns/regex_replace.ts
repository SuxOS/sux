import { type Fn, fail, ok } from "../registry";

// Regex find/replace over text. Pure, no network. Delegates group substitution
// ($1, $<name>, $&, …) to native String.replace so it matches JS semantics.

export const regex_replace: Fn = {
	name: "regex_replace",
	description:
		"Regex find/replace over text. Provide `text`, a JS regex `pattern`, and a `replacement` (supports $1/$<name>/$& group refs). flags default to 'g' (any subset of gimsuy). Returns the replaced string; an invalid pattern or flags fail with the error.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text", "pattern", "replacement"],
		properties: {
			text: { type: "string", description: "Text to transform." },
			pattern: { type: "string", description: "JavaScript regular expression source." },
			replacement: { type: "string", description: "Replacement string; supports $1, $<name>, $& group references." },
			flags: { type: "string", default: "g", description: "Regex flags (subset of gimsuy). Defaults to 'g'." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.text !== "string") return fail("Provide `text` as a string.");
		if (typeof args?.pattern !== "string" || args.pattern === "") return fail("Provide a regex `pattern`.");
		if (typeof args?.replacement !== "string") return fail("Provide `replacement` as a string.");
		const flags = args?.flags == null ? "g" : String(args.flags);

		let re: RegExp;
		try {
			re = new RegExp(args.pattern, flags);
		} catch (e) {
			return fail(`Invalid regex: ${String((e as Error).message ?? e)}`);
		}

		try {
			return ok(args.text.replace(re, args.replacement));
		} catch (e) {
			return fail(`Replace failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
