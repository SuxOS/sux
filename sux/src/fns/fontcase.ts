import { defont } from "../normalize";
import { type Fn, fail, ok } from "../registry";

function block(
	upper?: number,
	lower?: number,
	digit?: number,
	overrides?: string,
): (s: string) => string {
	const map = new Map<number, string>();
	const fill = (base: number | undefined, start: number, count: number) => {
		if (base === undefined) return;
		for (let i = 0; i < count; i++) map.set(start + i, String.fromCodePoint(base + i));
	};
	fill(upper, 0x41, 26);
	fill(lower, 0x61, 26);
	fill(digit, 0x30, 10);
	if (overrides) {
		const glyphs = Array.from(overrides);
		for (let i = 0; i + 1 < glyphs.length; i += 2)
			map.set(glyphs[i].codePointAt(0)!, glyphs[i + 1]);
	}
	return (s: string) =>
		Array.from(s, (ch) => {
			const cp = ch.codePointAt(0)!;
			return map.get(cp) ?? ch;
		}).join("");
}

function fromPairs(pairs: string): (s: string) => string {
	const map = new Map<string, string>();
	const glyphs = Array.from(pairs);

	for (let i = 0; i + 1 < glyphs.length; i += 2) map.set(glyphs[i], glyphs[i + 1]);
	return (s: string) => Array.from(s, (ch) => map.get(ch) ?? ch).join("");
}

const SMALL_CAPS =
	"aᴀbʙcᴄdᴅeᴇfꜰgɢhʜiɪjᴊkᴋlʟmᴍnɴoᴏpᴘqϙrʀsꜱtᴛuᴜvᴠwᴡxxyʏzᴢ";
const CIRCLED_LETTERS =
	"aⓐbⓑcⓒdⓓeⓔfⓕgⓖhⓗiⓘjⓙkⓚlⓛmⓜnⓝoⓞpⓟqⓠrⓡsⓢtⓣuⓤvⓥwⓦxⓧyⓨzⓩ" +
	"AⒶBⒷCⒸDⒹEⒺFⒻGⒼHⒽIⒾJⒿKⓀLⓁMⓂNⓃOⓄPⓅQⓆRⓇSⓈTⓉUⓊVⓋWⓌXⓍYⓎZⓏ";

const ITALIC_HOLES = "hℎ";
const SCRIPT_HOLES =
	"BℬEℰFℱHℋIℐLℒMℳRℛeℯgℊoℴ";
const FRAKTUR_HOLES = "CℭHℌIℑRℜZℨ";
const DOUBLE_STRUCK_HOLES =
	"CℂHℍNℕPℙQℚRℝZℤ";

const FONTS: Record<string, (s: string) => string> = {
	bold: block(0x1d400, 0x1d41a, 0x1d7ce),
	italic: block(0x1d434, 0x1d44e, undefined, ITALIC_HOLES),
	bold_italic: block(0x1d468, 0x1d482),
	script: block(0x1d49c, 0x1d4b6, undefined, SCRIPT_HOLES),
	fraktur: block(0x1d504, 0x1d51e, undefined, FRAKTUR_HOLES),
	double_struck: block(0x1d538, 0x1d552, 0x1d7d8, DOUBLE_STRUCK_HOLES),
	monospace: block(0x1d670, 0x1d68a, 0x1d7f6),
	sans: block(0x1d5a0, 0x1d5ba, 0x1d7e2),
	sans_bold: block(0x1d5d4, 0x1d5ee, 0x1d7ec),
	small_caps: fromPairs(SMALL_CAPS),
	circled: fromPairs(CIRCLED_LETTERS),
	fullwidth: block(0xff21, 0xff41, 0xff10),
};

function words(s: string): string[] {
	return s
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean);
}

const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

const CASES: Record<string, (s: string) => string> = {
	lower: (s) => s.toLowerCase(),
	upper: (s) => s.toUpperCase(),
	title: (s) => words(s).map(cap).join(" "),
	sentence: (s) => {
		const t = s.toLowerCase().trim();
		return t.charAt(0).toUpperCase() + t.slice(1);
	},
	snake: (s) => words(s).map((w) => w.toLowerCase()).join("_"),
	kebab: (s) => words(s).map((w) => w.toLowerCase()).join("-"),
	camel: (s) =>
		words(s)
			.map((w, i) => (i === 0 ? w.toLowerCase() : cap(w)))
			.join(""),
	pascal: (s) => words(s).map(cap).join(""),
	constant: (s) => words(s).map((w) => w.toUpperCase()).join("_"),
	dot: (s) => words(s).map((w) => w.toLowerCase()).join("."),
	path: (s) => words(s).map((w) => w.toLowerCase()).join("/"),
};

const TARGETS = [...Object.keys(CASES), ...Object.keys(FONTS)];

export const fontcase: Fn = {
	name: "fontcase",
	description:
		"Convert text between programming cases and unicode font styles. to (required): " +
		`cases ${Object.keys(CASES).join(", ")}; fonts ${Object.keys(FONTS).join(", ")}. ` +
		"from (optional): source style hint; when set, the fonted input is normalized to ASCII first.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text", "to"],
		properties: {
			text: { type: "string" },
			to: { type: "string", enum: TARGETS },
			from: { type: "string" },
		},
	},
	cacheable: true,

	raw: true,
	run: async (_env, args) => {
		const to = String(args?.to ?? "");
		const apply = FONTS[to] ?? CASES[to];
		if (!apply) return fail(`Unknown to. Use one of: ${TARGETS.join(", ")}`);
		let text = String(args?.text ?? "");

		if (args?.from !== undefined && args?.from !== null && String(args.from) !== "") {
			text = defont(text);
		}
		return ok(apply(text));
	},
};
