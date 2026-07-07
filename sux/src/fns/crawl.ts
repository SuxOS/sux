import { type Fn, fail, ok } from "../registry";
import { fetchText, isHttpUrl } from "./_util";

const CONCURRENCY = 8;
const PAGE_MAX_BYTES = 512 * 1024;

export const crawl: Fn = {
	name: "crawl",
	description: "Breadth-first crawl from a seed URL. Follows same-origin links up to `depth` and `max` pages, returning each URL + its title. same_origin=false allows off-site links (still capped).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Seed absolute http(s) URL." },
			depth: { type: "integer", default: 1, minimum: 0, maximum: 3 },
			max: { type: "integer", default: 25, minimum: 1, maximum: 100 },
			same_origin: { type: "boolean", default: true },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const seed = String(args?.url ?? "");
		if (!isHttpUrl(seed)) return fail("url must be absolute http(s).");
		const maxDepth = Math.min(Number(args?.depth ?? 1), 3);
		const maxPages = Math.min(Number(args?.max ?? 25), 100);
		const sameOrigin = args?.same_origin !== false;
		const origin = new URL(seed).origin;

		const seen = new Set<string>([seed]);
		const results: Array<{ url: string; title: string | null; depth: number }> = [];
		let frontier: Array<{ url: string; depth: number }> = [{ url: seed, depth: 0 }];

		while (frontier.length && results.length < maxPages) {

			const level = frontier.slice(0, maxPages - results.length);

			const fetched: Array<{ status: number; html: string } | { error: string }> = new Array(level.length);
			let nextClaim = 0;
			async function worker(): Promise<void> {
				for (;;) {
					const i = nextClaim++;
					if (i >= level.length) return;
					try {
						const f = await fetchText(env, level[i].url, { maxBytes: PAGE_MAX_BYTES });
						fetched[i] = { status: f.status, html: f.text };
					} catch (e) {
						fetched[i] = { error: e instanceof Error ? e.message : String(e) };
					}
				}
			}
			await Promise.all(Array.from({ length: Math.min(CONCURRENCY, level.length) }, () => worker()));

			const next: Array<{ url: string; depth: number }> = [];
			for (let i = 0; i < level.length; i++) {
				const { url, depth } = level[i];
				const got = fetched[i];
				if ("error" in got) {

					if (depth === 0) return fail(`seed fetch failed: ${got.error}`);
					continue;
				}
				if (got.status >= 400) {
					if (depth === 0) return fail(`seed fetch returned HTTP ${got.status}.`);
					continue;
				}
				const html = got.html;
				const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? null;
				results.push({ url, title, depth });
				if (depth >= maxDepth) continue;

				if (results.length + next.length >= maxPages) continue;
				for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
					if (results.length + next.length >= maxPages) break;
					let abs: string;
					try {
						abs = new URL(m[1], url).href.split("#")[0];
					} catch {
						continue;
					}
					if (!isHttpUrl(abs) || seen.has(abs)) continue;
					if (sameOrigin && new URL(abs).origin !== origin) continue;
					seen.add(abs);
					next.push({ url: abs, depth: depth + 1 });
				}
			}
			frontier = next;
		}
		return ok(JSON.stringify({ seed, pages: results.length, results }, null, 2));
	},
};
