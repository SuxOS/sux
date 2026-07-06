import { type Fn, fail, ok } from "../registry";

// Make a URL/file-safe slug: NFKD-decompose to strip diacritics, lowercase,
// replace any run of non-alphanumerics with the separator, trim leading/trailing.

function slug(text: string, sep: string, max?: number): string {
	let s = text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "") // combining diacritical marks
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, sep);
	// Collapse repeated separators and trim them off both ends.
	if (sep) {
		const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		s = s.replace(new RegExp(`${esc}{2,}`, "g"), sep).replace(new RegExp(`^${esc}+|${esc}+$`, "g"), "");
	}
	if (max && max > 0 && s.length > max) {
		s = s.slice(0, max);
		if (sep) {
			const esc = sep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			s = s.replace(new RegExp(`${esc}+$`, "g"), ""); // don't end on a dangling separator
		}
	}
	return s;
}

export const slugify: Fn = {
	name: "slugify",
	description:
		"Make a URL/file-safe slug: strips accents (NFKD), lowercases, replaces non-alphanumeric runs with `sep` (default '-'), collapses repeats and trims. Optional `max` caps the length (without ending on a separator). Returns the slug.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "Text to slugify." },
			sep: { type: "string", description: "Separator for word boundaries.", default: "-" },
			max: { type: "integer", description: "Optional maximum slug length in characters.", minimum: 1 },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const text = typeof args?.text === "string" ? args.text : "";
		if (!text.trim()) return fail("Provide non-empty `text`.");
		const sep = typeof args?.sep === "string" ? args.sep : "-";
		const max = args?.max;
		if (max != null && (typeof max !== "number" || !Number.isInteger(max) || max < 1)) return fail("`max` must be a positive integer.");
		const result = slug(text, sep, typeof max === "number" ? max : undefined);
		return ok(result);
	},
};
