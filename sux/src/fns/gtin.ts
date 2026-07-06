import { type Fn, fail, ok } from "../registry";
import { loadHtml } from "./_util";

/**
 * GS1 mod-10 check-digit validation. Valid GTIN lengths are 8, 12, 13, 14.
 * Weights alternate 3,1,… applied right-to-left across all but the check digit.
 */
export function validGtin(code: string): boolean {
	if (!/^\d+$/.test(code) || ![8, 12, 13, 14].includes(code.length)) return false;
	const digits = code.split("").map(Number);
	const check = digits.pop()!;
	let sum = 0;
	for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
	return (10 - (sum % 10)) % 10 === check;
}

export const gtin: Fn = {
	name: "gtin",
	description:
		"Find and validate product barcodes (GTIN-8/12/13/14, i.e. UPC/EAN) on a page. Pulls candidates from JSON-LD (gtin13/gtin12/gtin8/gtin14/gtin), meta tags, and standalone digit runs, then checks each mod-10 digit. Pass a url or raw html. Returns JSON { valid, candidates }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) — or pass `html`." },
			html: { type: "string", description: "Raw HTML to parse instead of fetching a url." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const loaded = await loadHtml(env, args);
		if ("error" in loaded) return fail(loaded.error);

		const html = loaded.html;
		const candidates = new Set<string>();

		// JSON-LD keys: "gtin", "gtin8", "gtin12", "gtin13", "gtin14".
		for (const m of html.matchAll(/"gtin(?:8|12|13|14)?"\s*:\s*"?(\d{8,14})"?/gi)) candidates.add(m[1]);
		// Microdata / meta tags carrying a gtin.
		for (const m of html.matchAll(/(?:itemprop|property|name)=["']gtin\d*["'][^>]*content=["'](\d{8,14})["']/gi)) candidates.add(m[1]);
		for (const m of html.matchAll(/content=["'](\d{8,14})["'][^>]*(?:itemprop|property|name)=["']gtin\d*["']/gi)) candidates.add(m[1]);
		// Standalone digit runs of a valid GTIN length (bounded so 15+ digit ids don't match).
		for (const m of html.matchAll(/(?<!\d)(\d{8}|\d{12}|\d{13}|\d{14})(?!\d)/g)) candidates.add(m[1]);

		const all = [...candidates];
		const valid = all.filter(validGtin);
		return ok(JSON.stringify({ valid, candidates: all }, null, 2));
	},
};
