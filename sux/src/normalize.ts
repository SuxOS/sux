export type NormalizeForm = "NFC" | "NFD" | "NFKC" | "NFKD" | "none";

export type NormalizeOptions = {
	form?: NormalizeForm;
	defont?: boolean;
	stripZeroWidth?: boolean;
	stripControls?: boolean;
	normalizeNewlines?: boolean;
	stripBom?: boolean;
	collapseWhitespace?: boolean;
	trim?: boolean;
};

export const SANE: NormalizeOptions = {
	form: "NFC",
	defont: true,
	stripZeroWidth: true,
	stripControls: true,
	normalizeNewlines: true,
	stripBom: true,
	collapseWhitespace: false,
	trim: false,
};

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF\u00AD\u200E\u200F\u061C\u180E]/g;
const CONTROLS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

export function defont(s: string): string {

	let i = 0;
	while (i < s.length && s.charCodeAt(i) <= 0x7f) i++;
	if (i === s.length) return s;
	const out: string[] = [s.slice(0, i)];
	for (const ch of s.slice(i)) {

		if (ch.codePointAt(0)! <= 0x7f) {
			out.push(ch);
			continue;
		}
		const k = ch.normalize("NFKC");
		out.push(/^[A-Za-z0-9]{1,3}$/.test(k) ? k : ch);
	}
	return out.join("");
}

export function normalizeText(input: string, opts: NormalizeOptions = SANE): string {
	let s = input;
	if (opts.stripBom && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
	if (opts.normalizeNewlines) s = s.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n");
	if (opts.stripControls) s = s.replace(CONTROLS, "");
	if (opts.stripZeroWidth) s = s.replace(ZERO_WIDTH, "");

	if (/[^\x00-\x7F]/.test(s)) {
		if (opts.form && opts.form !== "none") s = s.normalize(opts.form);

		if (opts.defont && opts.form !== "NFKC" && opts.form !== "NFKD") s = defont(s);
	}
	if (opts.collapseWhitespace) {
		s = s
			.split("\n")
			.map((line) => line.replace(/[ \t]+/g, " ").replace(/ +$/g, ""))
			.join("\n")
			.replace(/\n{3,}/g, "\n\n");
	}
	if (opts.trim) s = s.trim();
	return s;
}

export function normalizeArgs<T>(value: T, opts: NormalizeOptions = SANE): T {
	if (typeof value === "string") return normalizeText(value, opts) as unknown as T;
	if (Array.isArray(value)) return value.map((v) => normalizeArgs(v, opts)) as unknown as T;
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = normalizeArgs(v, opts);
		return out as T;
	}
	return value;
}
