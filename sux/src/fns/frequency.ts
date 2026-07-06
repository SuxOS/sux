import { type Fn, fail, ok } from "../registry";

// Frequency counts over plain text — words, lines, or characters. Pure, no
// network. Words are case-insensitive and stripped of surrounding punctuation.

export const frequency: Fn = {
	name: "frequency",
	description:
		"Frequency counts over plain text. by: word (default, case-insensitive, punctuation-trimmed) | line | char. min_len drops items shorter than N. top caps the result to the N most frequent. Returns a JSON array [{ item, count }] sorted by count desc (ties broken alphabetically).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "Plain text to tally." },
			by: { type: "string", enum: ["word", "line", "char"], default: "word", description: "Unit to count." },
			top: { type: "integer", minimum: 1, description: "Return only the N most frequent items." },
			min_len: { type: "integer", minimum: 1, description: "Ignore items shorter than this length." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.text !== "string") return fail("Provide `text` as a string.");
		const text = args.text;
		const by = String(args?.by ?? "word");
		if (!["word", "line", "char"].includes(by)) return fail("by must be one of: word, line, char");
		const minLen = Number.isFinite(Number(args?.min_len)) && Number(args.min_len) > 0 ? Math.floor(Number(args.min_len)) : 0;
		const top = Number.isFinite(Number(args?.top)) && Number(args.top) > 0 ? Math.floor(Number(args.top)) : 0;

		let items: string[];
		if (by === "word") {
			items = text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) ?? [];
		} else if (by === "line") {
			items = text.split(/\r?\n/).filter((l: string) => l.length > 0);
		} else {
			items = [...text].filter((c: string) => !/\s/.test(c));
		}

		const counts = new Map<string, number>();
		for (const it of items) {
			if (minLen && [...it].length < minLen) continue;
			counts.set(it, (counts.get(it) ?? 0) + 1);
		}

		let out = [...counts.entries()]
			.map(([item, count]) => ({ item, count }))
			.sort((a, b) => b.count - a.count || a.item.localeCompare(b.item));
		if (top) out = out.slice(0, top);

		return ok(JSON.stringify(out, null, 2));
	},
};
