import { type Fn, fail, ok } from "../registry";

// Fast heuristic LLM token estimator — NOT a real tokenizer (no BPE/vocab). It
// blends a chars/4 estimate with the whitespace word count (words tend to be ~1.3
// tokens each) and takes the max, which tracks GPT/Claude-family counts well
// enough for budgeting. Treat the result as an estimate, not an exact count.
function estimateTokens(text: string): number {
	if (!text) return 0;
	const chars = [...text].length;
	const words = (text.trim().match(/\S+/g) ?? []).length;
	const byChars = Math.ceil(chars / 4);
	const byWords = Math.ceil(words * 1.3);
	return Math.max(byChars, byWords, words);
}

export const count_tokens: Fn = {
	name: "count_tokens",
	description: "Estimate the LLM token count of text with a fast heuristic (blend of chars/4 and word count) — an estimate, not a real tokenizer. Params: text (required). Returns JSON { chars, words, est_tokens }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The text to estimate token count for." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.text !== "string") return fail("text is required (string).");
		const text = args.text;
		const chars = [...text].length;
		const words = (text.trim().match(/\S+/g) ?? []).length;
		const est_tokens = estimateTokens(text);
		return ok(JSON.stringify({ chars, words, est_tokens }, null, 2));
	},
};
