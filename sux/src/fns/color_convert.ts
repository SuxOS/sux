import { type Fn, fail, ok } from "../registry";

type Rgb = { r: number; g: number; b: number };
type Hsl = { h: number; s: number; l: number };

/** Parse `#rgb`, `#rrggbb`, `rgb(r,g,b)`, or `hsl(h,s%,l%)` into RGB (0-255). Null if unrecognized. */
function parseColor(input: string): Rgb | null {
	const s = input.trim().toLowerCase();

	const hex = s.replace(/^#/, "");
	if (/^[0-9a-f]{3}$/.test(hex)) {
		return { r: parseInt(hex[0] + hex[0], 16), g: parseInt(hex[1] + hex[1], 16), b: parseInt(hex[2] + hex[2], 16) };
	}
	if (/^[0-9a-f]{6}$/.test(hex)) {
		return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };
	}

	const rgb = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*[\d.]+\s*)?\)$/);
	if (rgb) {
		const r = Number(rgb[1]);
		const g = Number(rgb[2]);
		const b = Number(rgb[3]);
		if ([r, g, b].some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return null;
		return { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
	}

	const hsl = s.match(/^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%\s*(?:,\s*[\d.]+\s*)?\)$/);
	if (hsl) {
		const h = Number(hsl[1]);
		const sat = Number(hsl[2]);
		const l = Number(hsl[3]);
		if ([h, sat, l].some((n) => !Number.isFinite(n)) || sat < 0 || sat > 100 || l < 0 || l > 100) return null;
		return hslToRgb({ h: ((h % 360) + 360) % 360, s: sat / 100, l: l / 100 });
	}

	return null;
}

function rgbToHsl({ r, g, b }: Rgb): Hsl {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	const d = max - min;
	let h = 0;
	let s = 0;
	if (d !== 0) {
		s = d / (1 - Math.abs(2 * l - 1));
		switch (max) {
			case rn:
				h = ((gn - bn) / d) % 6;
				break;
			case gn:
				h = (bn - rn) / d + 2;
				break;
			default:
				h = (rn - gn) / d + 4;
				break;
		}
		h *= 60;
		if (h < 0) h += 360;
	}
	return { h, s, l };
}

function hslToRgb({ h, s, l }: Hsl): Rgb {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	let r = 0;
	let g = 0;
	let b = 0;
	if (h < 60) [r, g, b] = [c, x, 0];
	else if (h < 120) [r, g, b] = [x, c, 0];
	else if (h < 180) [r, g, b] = [0, c, x];
	else if (h < 240) [r, g, b] = [0, x, c];
	else if (h < 300) [r, g, b] = [x, 0, c];
	else [r, g, b] = [c, 0, x];
	return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

function toHex({ r, g, b }: Rgb): string {
	const h = (n: number) => n.toString(16).padStart(2, "0");
	return `#${h(r)}${h(g)}${h(b)}`;
}

export const colorConvert: Fn = {
	name: "color_convert",
	description:
		"Convert a color between formats. value accepts `#rgb`, `#rrggbb`, `rgb(r,g,b)`, or `hsl(h,s%,l%)` (alpha, if present, is dropped). to: hex | rgb | hsl (required). Returns JSON { input, to, result }. Fails on an unparseable color.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["value", "to"],
		properties: {
			value: { type: "string", description: 'Color string, e.g. "#3af", "rgb(51,170,255)", "hsl(204,100%,60%)".' },
			to: { type: "string", enum: ["hex", "rgb", "hsl"], description: "Target format." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const value = String(args?.value ?? "").trim();
		const to = String(args?.to ?? "");
		if (!value) return fail("Provide a `value` color.");
		if (to !== "hex" && to !== "rgb" && to !== "hsl") return fail("to must be one of: hex, rgb, hsl");

		const rgb = parseColor(value);
		if (!rgb) return fail(`Could not parse color '${value}'. Use #rgb, #rrggbb, rgb(...), or hsl(...).`);

		let result: string;
		if (to === "hex") {
			result = toHex(rgb);
		} else if (to === "rgb") {
			result = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
		} else {
			const { h, s, l } = rgbToHsl(rgb);
			result = `hsl(${Math.round(h)}, ${Math.round(s * 100)}%, ${Math.round(l * 100)}%)`;
		}
		return ok(JSON.stringify({ input: value, to, result }, null, 2));
	},
};
