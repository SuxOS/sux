import { type Fn, fail, ok } from "../registry";

// Convert identifier casing. Tokenize on spaces/underscores/hyphens AND camelCase
// boundaries, then re-emit in the target style.

const TARGETS = ["camel", "snake", "kebab", "pascal", "title", "upper", "lower", "constant"] as const;
type Target = (typeof TARGETS)[number];

function tokenize(text: string): string[] {
	return (
		text
			// split on explicit separators
			.replace(/[\s_-]+/g, " ")
			// camelCase / PascalCase boundary: aB -> a B
			.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
			// acronym boundary: HTTPServer -> HTTP Server
			.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
			.trim()
			.split(/\s+/)
			.filter((w) => w.length > 0)
	);
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

function emit(words: string[], to: Target): string {
	const lower = words.map((w) => w.toLowerCase());
	switch (to) {
		case "camel":
			return lower.map((w, i) => (i === 0 ? w : cap(w))).join("");
		case "pascal":
			return lower.map(cap).join("");
		case "snake":
			return lower.join("_");
		case "kebab":
			return lower.join("-");
		case "constant":
			return lower.join("_").toUpperCase();
		case "title":
			return lower.map(cap).join(" ");
		case "upper":
			return lower.join(" ").toUpperCase();
		case "lower":
			return lower.join(" ");
	}
}

export const case_convert: Fn = {
	name: "case_convert",
	description:
		"Convert identifier casing. to (required): camel | snake | kebab | pascal | title | upper | lower | constant. Tokenizes on spaces/underscores/hyphens and camelCase boundaries, then re-emits. Returns the converted string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text", "to"],
		properties: {
			text: { type: "string", description: "Identifier or phrase to convert." },
			to: { type: "string", enum: [...TARGETS], description: "Target casing style." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const text = typeof args?.text === "string" ? args.text : "";
		if (!text.trim()) return fail("Provide non-empty `text`.");
		const to = args?.to;
		if (typeof to !== "string" || !TARGETS.includes(to as Target)) return fail(`to must be one of: ${TARGETS.join(", ")}`);
		const words = tokenize(text);
		if (words.length === 0) return fail("No word tokens found in `text`.");
		return ok(emit(words, to as Target));
	},
};
