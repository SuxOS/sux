import { type Fn, fail, ok } from "../registry";

// Cut text to a budget in chars, words, or tokens (~4 chars/token heuristic).
// Only appends the ellipsis when something was actually removed.

function truncateChars(text: string, max: number, ellipsis: string): string {
	if (text.length <= max) return text;
	const keep = Math.max(0, max - ellipsis.length);
	return text.slice(0, keep) + ellipsis;
}

function truncateWords(text: string, max: number, ellipsis: string): string {
	// Split on whitespace, preserving nothing but the words themselves.
	const words = text.split(/\s+/).filter((w) => w.length > 0);
	if (words.length <= max) return text.trim();
	return words.slice(0, max).join(" ") + ellipsis;
}

export const truncate: Fn = {
	name: "truncate",
	description:
		"Truncate text to a budget. unit: chars (default) | words | tokens (tokens use a ~4-chars/token heuristic). Appends `ellipsis` (default '…') ONLY when the text was actually cut. Returns the truncated string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text", "max"],
		properties: {
			text: { type: "string", description: "Text to truncate." },
			max: { type: "integer", description: "Budget: number of chars, words, or tokens to keep.", minimum: 0 },
			unit: { type: "string", enum: ["chars", "words", "tokens"], default: "chars" },
			ellipsis: { type: "string", description: "Marker appended when text is cut.", default: "…" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const text = typeof args?.text === "string" ? args.text : "";
		if (!text) return fail("Provide non-empty `text`.");
		const max = args?.max;
		if (typeof max !== "number" || !Number.isInteger(max) || max < 0) return fail("`max` must be a non-negative integer.");
		const unit = args?.unit ?? "chars";
		if (unit !== "chars" && unit !== "words" && unit !== "tokens") return fail("unit must be one of: chars, words, tokens");
		const ellipsis = typeof args?.ellipsis === "string" ? args.ellipsis : "…";

		if (unit === "words") return ok(truncateWords(text, max, ellipsis));
		// tokens ≈ 4 chars/token; chars is the identity budget.
		const charBudget = unit === "tokens" ? max * 4 : max;
		return ok(truncateChars(text, charBudget, ellipsis));
	},
};
