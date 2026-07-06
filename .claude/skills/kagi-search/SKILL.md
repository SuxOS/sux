---
name: kagi-search
description: Map a natural-language web-search request to the right Kagi MCP tool and lens. Use when the user wants to search the web, look something up, find recent news, restrict a search to specific sites/domains, scope to academic/forum/programming sources, or read a page's full content — via the Kagi connector (kagi_search_fetch, kagi_lens_search, kagi_extract).
---

# Kagi search & lenses

Route a search request to the best Kagi tool and, when scoping helps, the best
**lens**. A "lens" is just a bundle of Kagi search filters; `kagi_lens_search`
lets you compose one on the fly.

## Tool selection

- **`kagi_search_fetch`** — plain web search. Also accepts scoping args directly
  (`include_domains`, `exclude_domains`, `time_relative`, `after`, `before`,
  `file_type`, `workflow`, `lens_id`). Use for a straightforward query.
- **`kagi_lens_search`** — same search, but scoped through a **named preset** or
  ad-hoc filters, chosen from intent. Prefer this when the user implies a
  *category* of source ("academic", "forums", "just docs.rs").
- **`kagi_extract`** — fetch one page's full content as markdown (needs the URL).

## Mapping intent → lens

Pick a preset when the request names a source category:

| User says… | `lens` preset |
|---|---|
| academic / papers / scholarly / .edu | `academic` |
| forums / discussions / what people say | `forums` |
| programming / official docs / language reference | `programming` |
| world news / multiple perspectives | `news360` |
| recipe / cooking | `recipes` |
| indie / non-commercial / small web | `smallweb` |

Otherwise compose **ad-hoc filters** (these override a preset if both are given):

- "only on X and Y" → `include_domains: ["x.com","y.com"]`
- "not from X" → `exclude_domains: ["x.com"]`
- "recent" / "this week" / "lately" → `time_relative: "day" | "week" | "month"`
- "since 2024" / "before June" → `after` / `before` (ISO dates)
- "PDFs" / "spreadsheets" → `file_type: "pdf" | "xlsx" | …`
- news / videos / podcasts / images → `workflow`

## Examples

- "What do researchers say about transformer scaling?"
  → `kagi_lens_search { query: "transformer scaling laws", lens: "academic" }`
- "Find Rust async docs, only on docs.rs and doc.rust-lang.org"
  → `kagi_lens_search { query: "rust async", include_domains: ["docs.rs","doc.rust-lang.org"] }`
- "Latest news on the election, past week"
  → `kagi_lens_search { query: "election", workflow: "news", time_relative: "week" }`
- "Read this page" (+ URL) → `kagi_extract { url }`

## Adding new named lenses

Reusable lenses are defined in `src/mcp.ts` → `LENS_PRESETS` (one entry each,
`{ include_domains?, lens_id?, time_relative?, … }`). Add there, redeploy, then
reference the new name via `lens`.
