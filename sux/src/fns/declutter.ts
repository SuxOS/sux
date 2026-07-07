import { type Fn, fail, ok } from "../registry";
import { loadHtml, stripHtml } from "./_util";

const CLUTTER = "ad|ads|advert|adslot|banner|sponsor|promo|popup|modal|overlay|interstitial|cookie|consent|gdpr|newsletter|subscribe|signup|paywall|social-share|sharethis|addthis|share-bar|related-posts|recommended|taboola|outbrain|disqus|comments?";

function clean(html: string): string {
	let s = html
		// Comments + conditional comments.
		.replace(/<!--[\s\S]*?-->/g, "")
		// Whole clutter/inactive elements.
		.replace(/<(script|style|noscript|template|svg|iframe|form|object|embed|link|meta)\b[\s\S]*?<\/\1>/gi, "")
		// Self-closing / void variants of the above that have no closing tag.
		.replace(/<(?:link|meta|input|source)\b[^>]*>/gi, "")
		// Google/Amazon ad containers.
		.replace(/<ins\b[^>]*adsbygoogle[\s\S]*?<\/ins>/gi, "")
		// 1x1 / tracking pixels.
		.replace(/<img\b[^>]*(?:\b(?:width|height)=["']?1["']?[^>]*){2}[^>]*>/gi, "")
		.replace(/<img\b[^>]*\bsrc=["'][^"']*(?:doubleclick|googlesyndication|google-analytics|googletagmanager|scorecardresearch|quantserve|facebook\.com\/tr|pixel)[^"']*["'][^>]*>/gi, "");

	const wrapper = new RegExp(`<(div|section|aside|ul|ins|span)\\b[^>]*\\b(?:class|id)=["'][^"']*\\b(?:${CLUTTER})\\b[^"']*["'][^>]*>(?:(?!<\\1\\b)[\\s\\S])*?<\\/\\1>`, "gi");
	for (let i = 0; i < 3; i++) s = s.replace(wrapper, "");

	s = s
		.replace(/\son\w+=("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/\s(?:data-(?:track|ga|gtm|analytics|ad)[\w-]*)=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");

	return s.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

export const declutter: Fn = {
	name: "declutter",
	description:
		"Clean HTML uBlock-style before further processing: removes scripts, styles, iframes, ad/consent/newsletter/social/comment blocks, tracking pixels, and inline event handlers. Pass `url` or `html`; `to`: html (default) | text. Best-effort regex cleaning (no DOM). Compose before summarize/readability/markdown for cleaner output.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) and clean." },
			html: { type: "string", description: "Raw HTML to clean." },
			to: { type: "string", enum: ["html", "text"], default: "html", description: "Return cleaned HTML or stripped plain text." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const loaded = await loadHtml(env, args);
		if ("error" in loaded) return fail(loaded.error);
		try {
			const cleaned = clean(loaded.html);
			return ok(args?.to === "text" ? stripHtml(cleaned) : cleaned);
		} catch (e) {
			return fail(`declutter failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
