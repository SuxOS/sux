import { type Fn, ok } from "../registry";
import { FUNCTIONS } from "./index";

// The self-describing ROOT VERB. sux advertises ~95 leaf tools plus three
// personal-data namespace connectors (mail/vault/files); a skill file explains how
// they compose, but skills do NOT sync to mobile — so on a phone the agent sees the
// bare tool list and no map. `sux` IS that map, delivered as a single mobile-safe
// tool call: it returns the whole capability surface (domains → what each is for →
// the leaf fns under it → how to reach them) built live from the registry, so it
// never drifts from what's actually deployed. Call it first on an unfamiliar surface;
// then call any leaf directly as its own tool, e.g. search({query}) or ingest({url}).

type DomainSpec = { key: string; blurb: string; leaves: string[] };

// Curated grouping of the leaf fns into human-legible domains. A fn may appear under
// more than one domain when it genuinely serves both (a leaf is still one tool). Any
// registered fn NOT covered here is surfaced under "other" at render time, so a newly
// added leaf can never silently vanish from the map.
const DOMAINS: DomainSpec[] = [
	{ key: "search", blurb: "Web search across engines (Kagi, Google, Brave, DDG, Tavily, Exa).", leaves: ["search", "web_search", "tavily"] },
	{
		key: "fetch",
		blurb: "Retrieve & render pages through a residential proxy, with the scrape → render → render:mac escalation ladder for bot-walled sites; snapshots, redirects, robots, crawl.",
		leaves: ["scrape", "render", "proxy", "geo_fetch", "crawl", "wayback", "redirects", "robots"],
	},
	{
		key: "extract",
		blurb: "Parse HTML/text into structure — links, tables, metadata, readability, feeds, sitemaps, contacts, entities, CSS-select, grep, subtitles.",
		leaves: ["extract", "readability", "tables", "metadata", "feed", "sitemap", "contacts", "entities", "select", "grep", "subtitles"],
	},
	{
		key: "research",
		blurb: "Academic & forum databases with citation shaping and similarity.",
		leaves: ["arxiv", "pubmed", "openalex", "crossref", "semantic_scholar", "clinical_trials", "stackexchange", "reddit", "citation", "find_similar"],
	},
	{
		key: "shop",
		blurb: "Product / price / store search — fan-out (shop, product_search) or a named retailer.",
		leaves: ["shop", "product_search", "amazon", "walmart", "costco", "homedepot", "lowes", "kroger", "bestbuy", "ebay", "ace", "winco", "weekly_ad"],
	},
	{
		key: "convert",
		blurb: "Format transforms — markdown/html/csv/json/xml/yaml, PDF build/fill, image transcode, font-case fold.",
		leaves: ["markdown", "html", "csv", "json", "xml", "yaml", "pdf", "fillable", "image_convert", "fontcase"],
	},
	{
		key: "compute",
		blurb: "Encode / hash / compress / archive / OCR, Workers-AI text (summarize, translate, classify, redact), token-pack + declutter, voice restyle.",
		leaves: ["encode", "hash", "compress", "archive", "ocr", "summarize", "translate", "classify", "redact", "pack", "declutter", "voice"],
	},
	{
		key: "data",
		blurb: "Places, people, crypto, media, and network/DNS control-plane intel.",
		leaves: ["places", "people", "people_finder", "coingecko", "youtube", "watch", "linkedin", "facebook", "controld", "tailscale"],
	},
	{
		key: "storage",
		blurb: "R2 content-addressed blob store, KV, and the Dropbox app-folder.",
		leaves: ["store", "kv_get", "kv_put", "kv_list", "kv_delete", "dropbox"],
	},
	{
		key: "recall",
		blurb: "Memory: capture into the vault (ingest), then recall/oracle synthesize a cited answer across your stores.",
		leaves: ["obsidian", "ingest", "recall", "oracle"],
	},
	{ key: "tasks", blurb: "Todoist tasks & projects.", leaves: ["todoist"] },
	{ key: "mail", blurb: "Fastmail over the raw JMAP conduit (byte-exact methodCalls + auth + gates).", leaves: ["jmap"] },
	{ key: "compose", blurb: "Server-side combinators — map+reduce (batch), parallel fetch (batch_fetch), and {{prev}}-piping (pipe).", leaves: ["batch", "batch_fetch", "pipe"] },
	{ key: "meta", blurb: "This map (sux), the `fn` escape hatch (call any leaf by name), preferences, feedback issues, and self-diagnostics.", leaves: ["sux", "fn", "preferences", "issue", "selftest"] },
];

// The three personal-data namespaces mount as SEPARATE /<domain>/mcp connectors, not
// as leaf fns in this list — so they carry their own verbs (handle-discipline: list/
// search return refs, exactly one deliberate byte-read per namespace). Summarized here
// so the one map still points at them.
const NAMESPACES: Array<{ key: string; mount: string; blurb: string }> = [
	{ key: "vault", mount: "/vault/mcp", blurb: "Obsidian notes over git — read/write/append/edit, daily notes, capture. Also reachable via the `obsidian` + `ingest` leaves." },
	{ key: "mail", mount: "/mail/mcp", blurb: "Email + calendar + contacts on Fastmail (JMAP for mail, CalDAV for cal/tasks). Verbs: mail_search/read/thread/draft/send, cal_*/task_*, contact_*." },
	{ key: "files", mount: "/files/mcp", blurb: "Dropbox files — Mode A app-folder always-on; Mode B whole-Dropbox read/search with a gated, firewalled write path." },
];

const firstSentence = (desc: string): string => {
	const t = (desc.split(/\.\s/)[0] ?? "").trim();
	return t.length > 140 ? `${t.slice(0, 139)}…` : t;
};

export const sux: Fn = {
	name: "sux",
	surface: "front",
	// Self-description doesn't mutate anything and doesn't touch the network — it just
	// reflects the registry. Idempotent + read-only so a client treats it as free.
	annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
	description:
		"sux capability map — the single, mobile-safe entry point that describes the whole toolset. tools/list advertises only ~13 front verbs (sux, fn, search, scrape, shop, ingest, recall, oracle, pipe, batch, store, preferences, issue); the other ~80 capabilities are LEAVES, reached via the `fn` escape — fn({name, args}) — or by their own name. Skills explain how these compose, but skills don't sync to mobile — so call `sux` first on an unfamiliar surface to get the map: the DOMAINS (search, fetch, extract, research, shop, convert, compute, data, storage, recall, tasks, mail, compose, meta), what each is for, and the exact leaf fns under it. Then invoke any leaf, e.g. fn({name:\"arxiv\", args:{query}}) or a front verb directly like search({query}). Pass `domain` to zoom into one group and get each leaf's one-line summary; omit it for the full overview. The map is built live from the deployed registry, so it never drifts from what's actually available.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			domain: {
				type: "string",
				description: "Zoom into one domain (e.g. shop, fetch, recall) and list each leaf with its one-line summary. Omit for the full overview across all domains + namespaces.",
			},
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const byName = new Map(FUNCTIONS.map((f) => [f.name, f]));
		const want = typeof args?.domain === "string" ? args.domain.trim().toLowerCase() : "";

		// Single-domain zoom: each leaf with its own one-line summary.
		if (want) {
			const d = DOMAINS.find((x) => x.key === want);
			if (!d) {
				const keys = DOMAINS.map((x) => x.key).join(", ");
				return ok(`Unknown domain "${want}". Known domains: ${keys}. Omit \`domain\` for the full map.`);
			}
			const lines = d.leaves.map((n) => {
				const fn = byName.get(n);
				return fn ? `- \`${n}\` — ${firstSentence(fn.description)}` : `- \`${n}\` — (unavailable)`;
			});
			return ok([`# sux · ${d.key}`, "", d.blurb, "", `Call any of these directly as its own tool, e.g. \`${d.leaves[0]}({…})\`.`, "", ...lines].join("\n"));
		}

		// Full overview: every domain with its leaf names, the namespaces, and how to
		// invoke. Compact enough to read on a phone, complete enough to route from.
		const covered = new Set(DOMAINS.flatMap((d) => d.leaves));
		const out: string[] = [];
		out.push("# sux — capability map");
		out.push("");
		out.push(
			`${FUNCTIONS.length} tools + 3 namespace connectors. tools/list shows only ~13 front verbs; every other tool is a leaf — reach it with \`fn({name, args})\`, e.g. \`fn({name:"arxiv", args:{query}})\`. Front verbs you can call directly: \`search\`, \`scrape\`, \`shop\`, \`ingest\`, \`recall\`, \`oracle\`, \`pipe\`, \`batch\`, \`store\`. Pass \`sux({domain})\` to expand any group below.`,
		);
		out.push("");
		out.push("## Domains");
		for (const d of DOMAINS) {
			out.push("");
			out.push(`### ${d.key}`);
			out.push(d.blurb);
			out.push(`Leaves: ${d.leaves.map((n) => `\`${n}\``).join(", ")}`);
		}

		// Any registered leaf not placed in a domain — keeps the map exhaustive as the
		// registry grows without this file being updated.
		const uncovered = FUNCTIONS.map((f) => f.name).filter((n) => !covered.has(n));
		if (uncovered.length) {
			out.push("");
			out.push("### other");
			out.push("Registered leaves not yet grouped:");
			out.push(`Leaves: ${uncovered.map((n) => `\`${n}\``).join(", ")}`);
		}

		out.push("");
		out.push("## Namespaces (separate /<domain>/mcp connectors)");
		for (const n of NAMESPACES) {
			out.push("");
			out.push(`### ${n.key} — \`${n.mount}\``);
			out.push(n.blurb);
		}

		out.push("");
		out.push("## How to reach anything");
		out.push("- A front verb (in tools/list): call it directly, e.g. `search({query})`, `scrape({url})`.");
		out.push("- Any other leaf: `fn({name, args})`, e.g. `fn({name:\"tables\", args:{html}})`. Cache flags like `fresh` go inside `args`.");
		out.push("- Zoom a domain for per-leaf summaries: `sux({domain:\"shop\"})`.");
		out.push("- Compose leaves server-side: `batch` (map+reduce), `pipe` ({{prev}} chaining).");
		out.push("- Personal data lives behind the vault/mail/files connectors above, each with its own verbs.");

		return ok(out.join("\n"));
	},
};
