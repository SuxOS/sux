import { type Fn, fail, ok } from "../registry";

// Encode/decode HTML entities. Pure, no network, no DOM. Encoding always covers
// the five markup-significant characters; `non_ascii` additionally escapes every
// code point > 127 to a numeric ref. Decoding handles named + &#nn; + &#xnn;.

const ENCODE_BASE: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

// A compact set of common named entities for decoding. Anything else decodes via
// the numeric forms; unknown names are left untouched.
const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	euro: "€",
	pound: "£",
	yen: "¥",
	cent: "¢",
	deg: "°",
	middot: "·",
	times: "×",
	divide: "÷",
};

function encode(text: string, nonAscii: boolean): string {
	let out = "";
	for (const ch of text) {
		if (ENCODE_BASE[ch]) out += ENCODE_BASE[ch];
		else if (nonAscii && ch.codePointAt(0)! > 127) out += `&#${ch.codePointAt(0)};`;
		else out += ch;
	}
	return out;
}

function decode(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
		if (body[0] === "#") {
			const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
			if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return whole;
			try {
				return String.fromCodePoint(cp);
			} catch {
				return whole;
			}
		}
		const named = NAMED[body];
		return named !== undefined ? named : whole; // unknown named entity: leave as-is.
	});
}

export const htmlentities: Fn = {
	name: "htmlentities",
	description:
		"Encode or decode HTML entities. direction: encode (default) escapes & < > \" ' and — when non_ascii=true (default) — every non-ASCII code point to a numeric ref; decode resolves named entities plus &#nn; and &#xnn; numeric refs. Returns the converted string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "Text to convert." },
			direction: { type: "string", enum: ["encode", "decode"], default: "encode", description: "Conversion direction." },
			non_ascii: { type: "boolean", default: true, description: "encode only: also escape code points > 127 to numeric refs." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.text !== "string") return fail("Provide `text` as a string.");
		const direction = String(args?.direction ?? "encode");
		if (direction !== "encode" && direction !== "decode") return fail("direction must be 'encode' or 'decode'.");

		if (direction === "encode") {
			const nonAscii = args?.non_ascii === undefined ? true : args.non_ascii === true;
			return ok(encode(args.text, nonAscii));
		}
		return ok(decode(args.text));
	},
};
