import { type Fn, fail, ok } from "../registry";

// Pure text statistics — no model, no network. Word/sentence heuristics are
// deliberately simple so results are deterministic and Unicode-friendly.

/** Count words: runs of non-whitespace separated by whitespace. */
function countWords(text: string): number {
	const m = text.trim().match(/\S+/g);
	return m ? m.length : 0;
}

/** Count sentences: runs ending in . ! ? (or … ). Falls back to 1 for non-empty text with no terminator. */
function countSentences(text: string): number {
	const m = text.match(/[^.!?…]+[.!?…]+(?=\s|$)/g);
	if (m && m.length) return m.length;
	return text.trim() ? 1 : 0;
}

export const word_count: Fn = {
	name: "word_count",
	description:
		"Text statistics for plain text. Returns JSON { chars, chars_no_spaces, words, lines, sentences, reading_time_min } where reading_time_min = ceil(words / 200).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "Plain text to measure." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.text !== "string") return fail("Provide `text` as a string.");
		const text = args.text;

		const chars = [...text].length;
		const chars_no_spaces = [...text.replace(/\s/g, "")].length;
		const words = countWords(text);
		const lines = text === "" ? 0 : text.split(/\r\n|\r|\n/).length;
		const sentences = countSentences(text);
		const reading_time_min = Math.ceil(words / 200);

		return ok(JSON.stringify({ chars, chars_no_spaces, words, lines, sentences, reading_time_min }, null, 2));
	},
};
