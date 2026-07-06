import { type Fn, fail, ok } from "../registry";

// Mask a sensitive string, revealing only a few characters at each end
// (e.g. a card number → ****1234). Safe on short values: if the revealed
// window meets or exceeds the length, the whole value is masked so nothing
// leaks.

export const mask: Fn = {
	name: "mask",
	description:
		"Mask a sensitive string, revealing only its ends (e.g. ****1234). show_start (default 0) and show_end (default 4) keep that many characters at each end; char (default '*') is the fill. Short values are fully masked so nothing leaks. Returns the masked string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["value"],
		properties: {
			value: { type: "string", description: "The sensitive string to mask." },
			show_start: { type: "integer", minimum: 0, default: 0, description: "Characters to reveal at the start." },
			show_end: { type: "integer", minimum: 0, default: 4, description: "Characters to reveal at the end." },
			char: { type: "string", default: "*", description: "Single-character fill for the masked region." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.value !== "string") return fail("Provide a string `value`.");
		const value = args.value;

		const showStart = args?.show_start === undefined ? 0 : Number(args.show_start);
		const showEnd = args?.show_end === undefined ? 4 : Number(args.show_end);
		if (!Number.isInteger(showStart) || showStart < 0) return fail("`show_start` must be a non-negative integer.");
		if (!Number.isInteger(showEnd) || showEnd < 0) return fail("`show_end` must be a non-negative integer.");

		let char = args?.char === undefined ? "*" : String(args.char);
		if (char.length === 0) return fail("`char` must be a non-empty string.");
		char = char[0]; // use a single character for a stable-width mask.

		const len = value.length;
		// Reveal window meets/exceeds length (or empty value) → mask everything.
		if (len === 0 || showStart + showEnd >= len) return ok(char.repeat(len));

		const start = value.slice(0, showStart);
		const end = showEnd > 0 ? value.slice(len - showEnd) : "";
		const middle = char.repeat(len - showStart - showEnd);
		return ok(start + middle + end);
	},
};
