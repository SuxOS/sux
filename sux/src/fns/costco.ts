import { type Fn, fail, ok, type RtEnv } from "../registry";
import { smartFetch } from "../proxy";
import { normalizeMoney, type RetailProduct, type RetailResult } from "./_retail";

const errMsg = (e: unknown): string => String((e as Error)?.message ?? e);

function absUrl(href: string): string {
	if (/^https?:\/\//i.test(href)) return href;
	return `https://www.costco.com${href.startsWith("/") ? "" : "/"}${href}`;
}

function stripText(html: string): string {
	return html
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#0*39;|&#x0*27;|&apos;/gi, "'")
		.replace(/\s+/g, " ")
		.trim();
}

function firstImgSrc(html: string): string | undefined {
	const m = /<img\b[^>]*\bsrc="([^"]+)"/i.exec(html);
	return m ? m[1] : undefined;
}

function firstImgAlt(html: string): string | undefined {
	const m = /<img\b[^>]*\balt="([^"]+)"/i.exec(html);
	return m ? stripText(m[1]) : undefined;
}

function extractPrice(slice: string): number | undefined {
	const m =
		/automation-id="itemPriceOutput[^"]*"[^>]*>\s*\$?\s*([\d.,]+)/i.exec(slice) ??
		/class="[^"]*\bprice\b[^"]*"[^>]*>\s*\$?\s*([\d.,]+)/i.exec(slice) ??
		/\$\s*([\d,]+\.\d{2})/.exec(slice);
	return m ? normalizeMoney(m[1]) : undefined;
}

function fromEmbeddedJson(html: string): RetailProduct[] {
	const m = /adobeProductList"?\s*[:=]\s*(\[[\s\S]*?\])\s*[,;<}]/i.exec(html);
	if (!m) return [];
	let arr: any[];
	try {
		arr = JSON.parse(m[1]);
	} catch {
		return [];
	}
	if (!Array.isArray(arr)) return [];
	const products: RetailProduct[] = [];
	for (const p of arr) {
		const id = String(p?.productId ?? p?.id ?? p?.sku ?? "").trim();
		if (!id) continue;
		const title = stripText(String(p?.name ?? p?.productName ?? p?.title ?? ""));
		if (!title) continue;
		products.push({
			id,
			title,
			price: normalizeMoney(p?.salePrice ?? p?.price ?? p?.finalPrice ?? p?.listPrice),
			currency: "USD",
			image: p?.image ?? p?.imageUrl ?? p?.thumbnailUrl,
			url: p?.url ? absUrl(String(p.url)) : `https://www.costco.com/.product.${id}.html`,
		});
	}
	return products;
}

function fromTiles(html: string): RetailProduct[] {
	const anchorRe = /<a\b[^>]*href="([^"]*\.product\.(\d+)\.html[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
	type Entry = { url: string; start: number; title?: string; alt?: string; image?: string };
	const byId = new Map<string, Entry>();
	for (let m = anchorRe.exec(html); m; m = anchorRe.exec(html)) {
		const [, href, id, inner] = m;
		let e = byId.get(id);
		if (!e) {
			e = { url: absUrl(href), start: m.index };
			byId.set(id, e);
		}
		if (!e.title) {
			const t = stripText(inner);
			if (t) e.title = t;
		}
		if (!e.alt) e.alt = firstImgAlt(inner);
		if (!e.image) e.image = firstImgSrc(inner);
	}
	if (!byId.size) return [];
	const starts = [...byId.values()].map((e) => e.start).sort((a, b) => a - b);
	const products: RetailProduct[] = [];
	for (const [id, e] of byId) {
		const nextStart = starts.find((s) => s > e.start) ?? html.length;
		const window = html.slice(e.start, Math.min(nextStart, e.start + 3000));
		const title = e.title ?? e.alt ?? "";
		if (!title) continue;
		products.push({
			id,
			title,
			price: extractPrice(window),
			currency: "USD",
			image: e.image ?? firstImgSrc(window),
			url: e.url,
		});
	}
	return products;
}

function extractProducts(html: string): RetailProduct[] {
	try {
		const json = fromEmbeddedJson(html);
		if (json.length) return json;
		return fromTiles(html);
	} catch {
		return [];
	}
}

export const costco: Fn = {
	name: "costco",
	description:
		"Costco product search. Costco is behind Akamai but its wall is JA3/fingerprint-centric, so this fetches the CatalogSearch results HTML through the residential curl-impersonate proxy and extracts normalized products. " +
		"`action`: search (only). Best-effort HTML extraction; if Akamai blocks the page it fails with a hint to try render backend:mac. Returns normalized JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search"], default: "search" },
			term: { type: "string", description: "Search text." },
			limit: { type: "integer", minimum: 1, maximum: 40, default: 15 },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		const action = String(args?.action ?? "search");
		if (action !== "search") return fail(`costco: unsupported action '${action}'.`);
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("costco: action=search requires a `term`.");
		const limit = Math.min(40, Math.max(1, Number(args?.limit) || 15));

		const url = `https://www.costco.com/CatalogSearch?keyword=${encodeURIComponent(term)}`;
		let html: string;
		try {
			const resp = await smartFetch(env, url, {}, "proxy");
			html = await resp.text();
		} catch (e) {
			return fail(`costco: fetch failed — ${errMsg(e)}`);
		}

		const products = extractProducts(html).slice(0, limit);
		if (!products.length) {
			const blocked = /Access Denied|sec-if-cpt/i.test(html) || html.trim().length < 1000;
			return fail(blocked ? "costco: blocked by Akamai (try render:mac) — no products" : "costco: no products extracted (layout change)");
		}

		const result: RetailResult = { retailer: "costco", action: "search", count: products.length, products };
		return ok(JSON.stringify(result, null, 2));
	},
};
