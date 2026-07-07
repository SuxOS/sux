import { macRender } from "../mac-render";
import { type Fn, fail, ok, type RtEnv } from "../registry";
import { normalizeMoney, type RetailProduct } from "./_retail";

const NO_PRODUCTS_MSG = "homedepot: no products extracted (challenge or layout change).";

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&#38;/g, "&")
		.replace(/&quot;/g, '"')
		.replace(/&#34;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&nbsp;/g, " ")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.trim();
}

function fromStateBlob(html: string): RetailProduct[] {
	const m = html.match(/window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i);
	if (!m) return [];
	let state: any;
	try {
		state = JSON.parse(m[1]);
	} catch {
		return [];
	}
	const out: RetailProduct[] = [];
	try {
		for (const v of Object.values(state)) {
			const node = v as any;
			const itemId = node?.itemId ?? node?.identifiers?.itemId;
			if (!itemId || !(node?.__typename === "Product" || node?.identifiers)) continue;
			const ident = node?.identifiers ?? {};
			const title = ident?.productLabel ?? node?.productLabel ?? node?.title;
			const price = node?.pricing?.value ?? node?.pricing?.original ?? node?.price?.value;
			const image = node?.media?.images?.[0]?.url ?? node?.image;
			const canonical = ident?.canonicalUrl ?? node?.canonicalUrl;
			out.push({
				id: String(itemId),
				title: title ? decodeEntities(String(title)) : undefined,
				price: normalizeMoney(price),
				currency: "USD",
				image: typeof image === "string" ? image.replace(/<SIZE>/g, "400") : undefined,
				url: canonical ? new URL(canonical, "https://www.homedepot.com").href : `https://www.homedepot.com/p/${itemId}`,
			} as RetailProduct);
		}
	} catch {
		return out;
	}
	return out;
}

function fromPods(html: string): RetailProduct[] {
	const out: RetailProduct[] = [];
	const seen = new Set<string>();

	const chunks = html.split(/data-testid="product-pod"/i).slice(1);
	for (const chunk of chunks) {
		try {
			const href = chunk.match(/href="(\/p\/[^"]*?\/(\d{6,})[^"]*)"/i);
			if (!href) continue;
			const itemId = href[2];
			if (seen.has(itemId)) continue;
			seen.add(itemId);
			const url = new URL(href[1], "https://www.homedepot.com").href;

			const alt = chunk.match(/alt="([^"]{3,})"/i);
			const header = chunk.match(/product-pod__title[^>]*>([\s\S]*?)<\/[a-z]/i);
			const rawTitle = alt?.[1] ?? (header?.[1] ? header[1].replace(/<[^>]+>/g, " ") : undefined);

			const price = chunk.replace(/<[^>]+>/g, "").match(/\$\s*([0-9][0-9,]*(?:\.[0-9]{2})?)/);

			const img = chunk.match(/src="(https:\/\/images\.thdstatic\.com\/[^"]+)"/i);
			out.push({
				id: itemId,
				title: rawTitle ? decodeEntities(rawTitle.replace(/\s+/g, " ")) : undefined,
				price: normalizeMoney(price?.[1]),
				currency: "USD",
				image: img?.[1],
				url,
			} as RetailProduct);
		} catch {
			// One malformed tile never aborts the whole parse.
		}
	}
	return out;
}

export const homedepot: Fn = {
	name: "homedepot",
	cost: 5,
	description:
		"Home Depot product search via the mac render backend (a residential patched browser that warms Home Depot's active Akamai `_abck` sensor and renders the client-side product grid — a plain fetch can't). " +
		"`action`: search (products for a `term`). Extraction is best-effort from the rendered page (embedded state blob when present, else product-pod tiles), normalized to the shared retail shape (id/title/price/image/url). " +
		"`zip` optionally localizes the store; `limit` caps results (default 15, max 40). Slower than an API and dependent on the mac render backend being up.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: { type: "string", enum: ["search"], default: "search", description: "search (by term)." },
			term: { type: "string", description: "Search text." },
			zip: { type: "string", description: "ZIP code to localize the store (optional)." },
			limit: { type: "integer", minimum: 1, maximum: 40, default: 15, description: "Max results." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env: RtEnv, args) => {
		const term = String(args?.term ?? "").trim();
		if (!term) return fail("action=search requires a `term`.");
		const limit = Math.min(40, Math.max(1, Number(args?.limit) || 15));

		const r = await macRender(env, {
			url: `https://www.homedepot.com/s/${encodeURIComponent(term)}`,
			as: "html",
			block_resources: true,
			wait_until: "networkidle2",
			wait_ms: 6000,
			timeout_ms: 55000,
		});
		if (!r.ok) return fail(`homedepot: blocked or render failed — ${r.error}`);

		let products = fromStateBlob(r.body);
		if (products.length === 0) products = fromPods(r.body);
		products = products.filter((p) => p.id && p.title).slice(0, limit);
		if (products.length === 0) return fail(NO_PRODUCTS_MSG);
		return ok(JSON.stringify({ retailer: "homedepot", action: "search", count: products.length, products }, null, 2));
	},
};
