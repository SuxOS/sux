import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";
import { stripHtml } from "./_util";

type ShopHit = { title: string; price?: string; source?: string; url?: string };

// Retailers with a dedicated, robust sux fn — point there instead of scraping.
const DEDICATED: Record<string, string> = {
	walmart: "walmart",
	home_depot: "homedepot",
	homedepot: "homedepot",
	bestbuy: "bestbuy",
	best_buy: "bestbuy",
	ebay: "ebay",
	costco: "costco",
	kroger: "kroger",
	fred_meyer: "kroger",
};

const priceRe = /\$[\d,]+(?:\.\d{2})?/;
const unwrap = (href: string): string | null => (href.startsWith("/url?") ? new URLSearchParams(href.slice(href.indexOf("?") + 1)).get("q") : /^https?:\/\//.test(href) ? href : null);

/** Best-effort parse of a Google Shopping (tbm=shop) HTML page: product anchors
 * with a nearby price. Google's markup churns, so this is heuristic — title +
 * price + merchant host + link. Dedupes by title. */
export function parseGoogleShopping(html: string, limit: number): ShopHit[] {
	const hits: ShopHit[] = [];
	const seen = new Set<string>();
	const re = /<a [^>]*href="([^"]+)"[^>]*>([\s\S]{0,300}?)<\/a>([\s\S]{0,300}?)(\$[\d,]+(?:\.\d{2})?)/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) && hits.length < limit) {
		const url = unwrap(m[1]);
		if (!url) continue;
		let host = "";
		try {
			host = new URL(url).hostname.replace(/^www\./, "");
		} catch {
			continue;
		}
		if (/google\.[a-z.]+$|gstatic\.com$/i.test(host)) continue;
		const title = stripHtml(m[2]).trim();
		if (title.length < 3) continue;
		const key = title.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		hits.push({ title, price: m[4].match(priceRe)?.[0], source: host, url });
	}
	return hits;
}

const fmt = (hits: ShopHit[]): string =>
	hits.length ? hits.map((h, i) => `${i + 1}. ${h.title}${h.price ? ` — ${h.price}` : ""}${h.source ? ` [${h.source}]` : ""}${h.url ? `\n   ${h.url}` : ""}`).join("\n\n") : "(no results)";

export const shop: Fn = {
	name: "shop",
	cost: 3,
	description:
		"Product search via Google Shopping, scraped DIRECTLY through the residential proxy (no API key — the old SerpAPI path is gone). `query` is the product; returns numbered products with price, merchant, and link. For a specific big retailer, prefer its dedicated fn — walmart, homedepot, bestbuy, ebay, costco, kroger — which returns structured data; passing store:'walmart' etc. here just points you at that fn. Google Shopping markup churns, so results are best-effort.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["query"],
		properties: {
			query: { type: "string", description: "Product query." },
			store: { type: "string", description: "Optional: a retailer name to be redirected to its dedicated fn; default is Google Shopping across all merchants." },
			limit: { type: "integer", minimum: 1, maximum: 25, default: 10 },
		},
	},
	cacheable: true,
	ttl: 300, // prices/availability are live external state — keep fresh
	run: async (env, args) => {
		const q = String(args?.query ?? "").trim();
		if (!q) return fail("query is required.");
		const store = String(args?.store ?? "").trim().toLowerCase();
		if (store && DEDICATED[store]) return fail(`For ${store}, use the dedicated \`${DEDICATED[store]}\` fn (structured, robust). \`shop\` (no store) searches Google Shopping across all merchants.`);
		const limit = Math.min(25, Math.max(1, Number(args?.limit) || 10));

		try {
			const url = `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}&hl=en&num=${Math.min(40, limit + 10)}`;
			const resp = await smartFetch(env, url, { headers: { "Accept-Language": "en-US,en;q=0.9" } });
			if (resp.status >= 400) return fail(`Google Shopping HTTP ${resp.status}`);
			const hits = parseGoogleShopping(await resp.text(), limit);
			if (!hits.length) return ok(`(no products parsed for "${q}" — Google Shopping markup may have changed; try a dedicated retailer fn)`);
			return ok(fmt(hits));
		} catch (e) {
			return fail(`shop failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
