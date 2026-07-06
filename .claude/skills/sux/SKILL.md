---
name: sux
description: Route a task to the right sux edge function — web search, scrape/fetch through a residential proxy (full/smart/geo), extract/parse HTML (links, tables, metadata, readability, feeds, sitemaps, contacts, barcodes), convert formats (html↔markdown, csv/yaml/xml↔json, subtitles), compress/archive/encode/hash, minify + token-shrink, Workers-AI text (summarize, translate, classify, embed, ocr), and utilities (dns, whois, ip_geo, tls, redirects, robots, wayback, jwt, diff, calc, units, datetime, redact). Use when the user wants any web fetch, data transform, extraction, or lightweight compute done at the edge via the sux MCP connector.
---

# sux — the edge function engine

sux is one Cloudflare Worker exposing ~58 composable functions as MCP tools
(Julia-style generic verbs + multiple dispatch). **Kagi is just one function (`search`).**
Full inventory + status: **`sux/FUNCTIONS.md`** (run `npm run docs` to regenerate).

## How to route

Pick the **narrowest** function that answers the need; compose in front of heavier ones
to keep token cost down (e.g. `grep`/`select`/`readability` before dumping a whole page).

| The user wants… | function |
|---|---|
| web search / news / videos | `search` (Kagi) |
| local shopping / prices near me | `local_shop` |
| fetch a page that blocks datacenter IPs | `scrape` / `protocol` |
| raw HTTP with full control | `protocol` (smart) · `proxy` (full residential) |
| main article text (strip nav/ads) | `readability` |
| links / JSON-LD / plain text from HTML | `extract` |
| tables · metadata · feeds · sitemaps | `tables` · `metadata` · `feed` · `sitemap` |
| CSS-select / regex-grep a page | `select` · `grep` |
| emails & phones · barcodes | `contacts` · `gtin` / `barcode_lookup` |
| convert formats | `html_markdown` · `csv_json` · `yaml_json` · `xml_json` · `subtitles` |
| compress / archive / encode / hash | `compress` · `archive` · `encode` · `hash` |
| minify an asset · shrink tokens | `optimize` · `shrink` (`kind:"token"`) |
| summarize / translate / classify / embed / OCR | `summarize` · `translate` · `classify` · `embed` · `ocr` |
| PII redaction | `redact` |
| dns · whois · ip geo · tls · redirects · robots | `dns` · `whois` · `ip_geo` · `tls_info` · `redirects` · `robots` |
| archived snapshot / page history | `wayback` |
| jwt · diff · calc · units · datetime · validate | `jwt` · `diff` · `calc` · `units` · `datetime` · `validate` |
| query a JSON blob by path | `json_query` |
| YouTube transcript | `youtube` |

## Fetch routing modes (keep all three)

- **smart** (default) — cheapest rung first; residential only when a datacenter IP is
  blocked; direct fallback so it never hard-fails. (`scrape`, `protocol`.)
- **full proxy** — force everything through the residential exit, no fallback. (`proxy`.)
- **geo** — pick the exit locale for region-priced / geo-gated data.

## Conventions

- Every result is MCP text; structured data is JSON, binary is base64 inside JSON.
- Cacheable functions are memoized in KV by a hash of their arguments — repeat calls are free.
- Bidirectional verbs take a `direction` arg (e.g. `csv_to_json` ↔ `json_to_csv`).
- Planned stubs (`html_to_pdf`, `pdf_to_text`, `pdf_to_images`, `office_to_pdf`,
  `image_convert`) return an honest error — they need Browser Rendering / WASM not yet wired.

## Token discipline

sux does the heavy work server-side and returns only the distilled result. Prefer
projecting first: `grep`/`select`/`readability`/`json_query` to slice, `optimize` to
minify, `shrink(kind:"token")` to squeeze — then hand the small result to the model.
