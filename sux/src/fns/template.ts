import { type Fn, fail, ok } from "../registry";

// Fill a {{var}} template from a vars object. Pure, no network. Supports dotted
// keys ({{a.b}}) resolved against nested objects.

/** Read a nested value at a dotted key path. Returns undefined if any hop is missing. */
function getPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

/** Render a scalar to a string; objects/arrays are JSON-encoded. */
function render(v: unknown): string {
	if (v == null) return "";
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

export const template: Fn = {
	name: "template",
	description:
		"Fill a string template with {{var}} placeholders from a `vars` object (dotted keys like {{a.b}} resolve nested values). missing controls unresolved placeholders: keep (default) leaves {{var}} intact | empty replaces with '' | error fails listing the missing keys. Returns the rendered string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["template", "vars"],
		properties: {
			template: { type: "string", description: "Template text containing {{var}} placeholders." },
			vars: { type: "object", description: "Values keyed by placeholder name; nested objects for dotted keys." },
			missing: { type: "string", enum: ["keep", "empty", "error"], default: "keep", description: "Handling for unresolved placeholders." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.template !== "string") return fail("Provide `template` as a string.");
		const vars = args?.vars;
		if (vars == null || typeof vars !== "object" || Array.isArray(vars)) return fail("Provide `vars` as an object.");
		const missing = String(args?.missing ?? "keep");
		if (!["keep", "empty", "error"].includes(missing)) return fail("missing must be one of: keep, empty, error");

		const missingKeys: string[] = [];
		const rendered = args.template.replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (whole: string, key: string) => {
			const val = getPath(vars, key);
			if (val === undefined) {
				missingKeys.push(key);
				return missing === "empty" ? "" : whole; // "keep" restores the original placeholder; "error" handled below.
			}
			return render(val);
		});

		if (missing === "error" && missingKeys.length) {
			const uniq = [...new Set(missingKeys)];
			return fail(`Missing template variable(s): ${uniq.join(", ")}`);
		}

		return ok(rendered);
	},
};
