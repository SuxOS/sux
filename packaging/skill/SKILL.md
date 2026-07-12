---
name: sux
description: Route a task to the right sux edge function — web search (Kagi + native Google + Brave), scrape/fetch through a residential proxy (smart/full/geo), JS render via headless/real browser, crawl a site, extract/parse HTML (links, tables, metadata, readability, feeds, sitemaps, contacts, entities), convert formats (markdown, html, csv, json, xml, yaml, subtitles), build/fill PDFs, convert images, compress/archive/encode/hash, declutter + token-pack, Workers-AI text (summarize, translate, classify, ocr, redact), archived snapshots (wayback), retail product search (amazon/walmart/homedepot/costco/lowes/ace/kroger), keyless scholarly + finance + media APIs (arxiv, pubmed, crossref, openalex, coingecko, alphavantage, tmdb, youtube, …), and storage (R2 store + KV). Use when the user wants any web fetch, data transform, extraction, retail/scholarly lookup, or lightweight compute done at the edge via the sux MCP connector.
---

# sux — the edge function engine

sux is one Cloudflare Worker exposing ~80 small, composable functions as MCP tools
(Julia-style generic verbs + multiple dispatch). It fetches from **your own residential
IP** through infrastructure you control, caches on Cloudflare's edge, and does the
fetching, parsing, converting, and AI work **at the edge instead of in your context**.

**The live catalog is the source of truth: `sux/FUNCTIONS.md`** (regenerate with
`npm run docs`). Function names and counts drift — always check FUNCTIONS.md rather than
trusting a hardcoded list. This skill teaches *routing*, not the full inventory.

## Prerequisite: the sux MCP connector must be authorized

sux is a remote, OAuth-gated MCP server at `https://sux.colinxs.workers.dev/mcp`
(GitHub OAuth). If sux tools aren't available, the connector isn't connected/authorized
yet — in Claude Code run `/mcp` and complete sign-in for the `sux` server; in Claude
Desktop add it as a custom connector (see the plugin/extension READMEs). The tools appear
as `sux` MCP tools once the OAuth flow finishes.

## How to route

Pick the **narrowest** function that answers the need, and **compose cheap projectors in
front of heavy fetches** to keep token cost down (e.g. `grep`/`select`/`readability`/
`declutter` before dumping a whole page). sux does the heavy work server-side and returns
only the distilled result.

| The user wants… | function |
|---|---|
| web search / news | `search` (simple Kagi) · `web_search` (Kagi + native Google + Brave; fans out + can synthesize) |
| find pages semantically like a URL | `find_similar` |
| a page that blocks datacenter IPs | `scrape` (residential curl-impersonate, direct fallback) |
| force every request through a residential exit | `proxy` (full residential, no fallback) |
| pick the exit region for geo-priced / geo-gated data | `proxy` with an `x-exit-geo` header (e.g. `us-ca`, `de`) |
| a JavaScript-rendered page / screenshot / page-as-PDF | `render` (`backend: cf|mac`, `as: html|text|screenshot|pdf`; `mac` solves active bot challenges) |
| crawl a whole site / follow links | `crawl` · `sitemap` |
| many URLs at once | `batch_fetch` |
| redirect chain · robots rules · archived snapshot | `redirects` · `robots` · `wayback` |
| main article text (strip nav/ads) | `readability` |
| links / JSON-LD / structure from HTML | `extract` |
| tables · metadata · RSS/Atom feed | `tables` · `metadata` · `feed` |
| CSS-select · regex-grep a page | `select` · `grep` |
| emails & phones · named entities | `contacts` · `entities` |
| subtitles / transcript (SRT ⇄ VTT) | `subtitles` |
| strip ads/nav/tracking from HTML | `declutter` (compose before summarize/readability/markdown) |
| convert formats (verb = target format) | `markdown` · `html` · `csv` · `json` · `xml` · `yaml` |
| build / merge / OCR / paginate a PDF | `pdf` (anything→PDF; `as:"url"` for a download link) |
| add fillable form fields to a PDF | `fillable` |
| convert / resize an image | `image_convert` |
| compress · archive · encode · hash | `compress` · `archive` · `encode` · `hash` |
| shrink tokens of a JSON payload | `pack` (tabular re-encode, keys not repeated per row) |
| summarize · translate · classify · OCR · redact PII | `summarize` · `translate` · `classify` · `ocr` · `redact` |
| convert text case / unicode font styles | `fontcase` |
| chain tools server-side (COMPOSE) | `pipe` (each step's output feeds the next) |
| run one tool over many inputs (MAP + reduce) | `batch` |
| stash / fetch content by handle or URL | `store` (R2, content-addressed) · `kv_get`/`kv_put`/`kv_list`/`kv_delete` |
| retail product search | `amazon` · `walmart` · `homedepot` · `costco` · `lowes` · `ace` · `kroger` · `bestbuy` · `ebay` · `etsy` · `shop` (Google Shopping) |
| scholarly / research | `arxiv` · `pubmed` · `crossref` · `openalex` · `semantic_scholar` · `clinical_trials` · `stackexchange` |
| finance / crypto / compute | `alphavantage` · `coingecko` · `wolfram` |
| media / news / places / people | `tmdb` · `youtube` · `nyt` · `guardian` · `places` · `people` · `linkedin` · `facebook` |
| report a bug with sux | `issue` |

If a needed function isn't in this table, **grep `sux/FUNCTIONS.md`** — the catalog is
larger than this cheat-sheet and grows over time.

## The fetch ladder (bot-detection escalation)

Pick the **lowest rung that works** — each costs more but defeats more protection:

1. **direct** — plain Worker fetch. Fast/free; beats nothing hostile.
2. **`scrape`** — residential IP + Chrome TLS/JA3/HTTP2 via curl-impersonate. Beats
   datacenter blocks and *passive* fingerprinting (most Akamai/Cloudflare). Default choice.
3. **`render` backend:"cf"** — headless Chromium for client-rendered JS on non-hostile sites.
4. **`render` backend:"mac"** — real patched browser on the residential home IP; solves
   *active* JS challenges (Akamai `_abck` sensor, PerimeterX press-and-hold, DataDome).
   Slowest; auto-escalates to a solver tier when a page looks blocked.

Fetch modes to keep distinct: **smart** (`scrape`, cheapest-first with direct fallback),
**full proxy** (`proxy`, force residential, no fallback), **geo** (`proxy` with an `x-exit-geo` header, choose exit locale).

## Conventions

- Every result is MCP text; structured data is JSON, binary is base64 inside JSON
  (or `as:"url"` for a CAS-backed download link on binary outputs).
- Cacheable functions are memoized in KV by a hash of their arguments — repeat calls are
  free. Pass `fresh:true` to bypass the cache.
- Converters are named for their **target** format (`markdown`, `html`, `csv`, `json`,
  `xml`, `yaml`) and auto-detect the input — e.g. call `json` with CSV or YAML in, `csv`
  with JSON in.
- Retail fns route to the lowest fetch rung that works (official API where one exists,
  else `scrape`, else `render:mac`); you just call the retailer by name.

## Token discipline

Prefer projecting first: `grep`/`select`/`readability` to slice, `declutter` to strip
chrome, `pack` to squeeze — then hand the small result to the model. Use `pipe` to keep
a multi-step transform entirely server-side so intermediates never enter context.
