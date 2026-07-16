---
title: Build program roadmap
status: meta
cluster: meta
type: meta
summary: "Coherence anchor for the PARKED web/algebra program — shared-substrate owner table, frozen interfaces, build order; home of the two hard facts (60s deadline, 24h stale-grace)."
tags: [sux, meta, meta]
updated: 2026-07-09
---

> **Status: parked** (re-triggers stand — see the summary above). Canonical
> reading order (2026-07-16, Ledger R8): [`north-star.md`](../design/north-star.md)
> (principles) → [`SUX.md`](SUX.md) (current thesis, amended by
> [`pivot-validation-2026-07.md`](../design/pivot-validation-2026-07.md)) →
> [`op-engine-design.md`](../superpowers/specs/2026-07-15-suxos-v2-op-engine-design.md)
> (execution architecture) → `PLAN.md` / this file (historical/parked).

# sux build program — roadmap

Seven design proposals (this directory) form one coherent build program, not seven independent features. They share substrate modules; the ownership and build order below are what keep them from diverging. This file is the coherence anchor — when two docs specify the same shared module, this file names the owner and the frozen interface.

## The features

| Doc | Verb(s) | One line |
|---|---|---|
| [search.md](search.md) | `search(query, backends, filter)` | One parallel retrieval verb over web/research/social/retail backends with a WHERE-filter. |
| [teach-ask.md](teach-ask.md) | `teach(subject, goal)` / `ask(query)` | Knowledge engine on a KV `_kb` substrate + Obsidian vault projection. |
| [style-edit.md](style-edit.md) | `style(source)` / `edit(doc, style)` | Learn a writing style, restyle a document; server-rewrite + spec-return. |
| [shop.md](shop.md) | `shop(item)` | Cross-retailer comparison engine over the shared retail fan-out. |
| [travel.md](travel.md) | `travel(from, to)` | Flights/hotels/attractions/visa/price-trend dossier (production Amadeus). |
| [algebra.md](algebra.md) | `map`/`filter`/`reduce`/`augment` | The records[] data algebra under every verb. |
| [platform-upgrades.md](platform-upgrades.md) | `notify`/`diff`/`job`/`browse`/`entity` + mac-LLM + Workflows | Infrastructure the verbs stand on. |
| [jmap.md](jmap.md) | `jmap({calls} \| {method,args})` | Full Fastmail/JMAP protocol as one typed conduit verb (email/contacts/calendars/masked-email); composes into the algebra. |

## Shared substrate — owners and frozen interfaces

Every verb consumes these; each module has exactly one owner. A change to a frozen interface is a co-signed edit to the owner's doc **and** every consumer's doc in the same cycle.

| Module | Owner | Consumers | Frozen interface |
|---|---|---|---|
| `_records.ts` (envelope, `okRecords`/`safeStringify`/`toRecords`/`dig`/`Rec`) | algebra | all | `{records: Rec[], meta}`; failures only in `meta.errors[]`; one reserved key `_src`; `safeStringify` escapes U+2028/2029. |
| `_fanout.ts` (`Slot`/`FanoutOutcome`/`fanout`) | algebra | search, shop, travel, platform | `FanoutOutcome` maps 1:1 onto the records envelope; caller owns its cap; env cloned per depth (`{...env,_depth+1}`). |
| `_filter.ts` (`Predicate & {paths}`, `compileFilter`) | search | algebra's `filter` fn | String WHERE-DSL; `compileFilter(expr): Predicate & {paths}`; prefix `exists`; missing→false except `exists`; synonym lexer (`==`/`&&`/`\|\|`/`contains`); `~` deferred (Thompson NFA later, never `new RegExp`). |
| `_kb.ts` (v3, kind-scoped keys) | teach-ask | style-edit, entity | Keys `sux:kb:knowledge:<topic>` / `sux:kb:voice:<name>` — kind is **structural**, not a value field; `saveKb(env, rec, {maxChunks})`; legacy `sux:oracle:*`→knowledge, `sux:prefs:*`→voice; `_kb` header names both teach/ask and style/edit as sanctioned consumers. |
| `_retail_fanout.ts` (`fanoutRetail`/`TaggedProduct`/`FanoutResult`/`RETAIL_ADAPTERS`/`FAST_TIER`/`RENDER_TIER`) | shop | search | `fanoutRetail(env, {term, retailers, zip, fetchN})`; 45s soft deadline; `maxConcurrentRenders:3`; whichever of search/shop lands first owns the file, the other rebases. |
| `_entity.ts` (identity resolution helpers) | platform (entity) | shop's `_compare`, teach's dedup | Pure helpers, content-hash idempotency (not URL), no SKU-as-UPC mislabel. |
| `_reduce.ts` (llm-fold: `summarize`/`pack`) | algebra | summarize.ts, teach (distill) | The single distillation home; `summarize.ts` delegates; teach absorbs `oracle`. |
| `job` fn + `sux:job:` registry | platform (proactive) | Workflows, travel `track` | One job fn over one registry; `notify` fires on completion (closes the cron-result-rot gap). |
| `Fn.staleGrace?` / `Fn.width?` / `Fn.records?` | registry.ts | search, shop, algebra | Shared `Fn` fields; added once, consumed by all. |

## The two hard facts every doc respects

1. **`FN_DEADLINE_MS = 60_000`** wraps every `fn.run` (`index.ts:41/:252`) and abandons the whole run on timeout with zero partials. Every fan-out verb runs an internal ~45–50s soft budget and returns partials as a success envelope; render-tier work is opt-in and capped.
2. **`CACHE_STALE_GRACE_SECONDS = 86_400`** (`mcp-util.ts:58`): a `ttl:300` result is served stale up to 24h. Live-data verbs set `Fn.staleGrace` (600 for search/shop) or `cacheable:false` (teach/ask/edit); partial-error envelopes are `noCache`.

## Global build order

Substrate first, then the verbs that stand on it. One change per plan→test→deploy→push cycle.

**Phase 0 — substrate.** `_records.ts` + `dig` → `_fanout.ts` + env-clone → `_filter.ts` (co-signed grammar freeze, incl. `paths` export) → `registry.ts` `Fn` fields (`staleGrace`/`width`/`records`) → `_kb.ts` v3 (kind-scoped keys) → `_retail_fanout.ts` extraction (verbatim-neutral).

**Phase 1 — algebra verbs.** `filter` → `reduce` (+ `summarize` delegates) → `map` → `save`/`pipe.persist` → `augment` + cheap adapter catalog (`archive`/`meta`/`price`/`nearby`).

**Phase 2 — search.** Rewrite on `_fanout` + `_filter` + `_retail_fanout`; web group → delete `web_search`; research → social → retail groups (+ `rating`/`reviews` lift in `_retail.ts`); gate-delete `product_search`.

**Phase 3 — knowledge.** `teach`/`ask` on `_kb`; acquisition routing; vault projection; absorb `oracle` + `preferences`; `maintenanceTick` legacy sweep.

**Phase 4 — style.** `style`/`edit` on `_kb` voice kind; taxonomy + census machinery; deprecation shims → delete `voice` (+ its half of `preferences`).

**Phase 5 — shop.** `_compare.ts` on `_retail_fanout` + `_entity`; rewrite `shop` in place; delete `localshop` tool; finalize `product_search` deletion.

**Phase 6 — platform.** `notify` → `diff` → `job` + cron branch → mac-LLM tier → `browse` → Workflows infra + `entity`.

**Phase 7 — travel.** `_travel.ts` + generated airports table; flights+links → hotels → attractions → visa → price_trend + `track` (via the Phase 6 job registry); production Amadeus setup.

## Fn-count trajectory (reconciled — cap lifted, so this is informational, not a gate)

Start **89**. Each deletion counted **once**:

- **Deletions (−5):** `web_search`, `product_search` (claimed by both search.md and shop.md → **counted once**, gated on `search(backends:'retail')` shipping and consuming `fanoutRetail`), `oracle`, `preferences` (claimed by both teach-ask.md and style-edit.md → **one deletion**: teach/ask owns the migration, style owns the resurrected voice kind), `voice`. (`localshop` is a `src/tools/` export, **not** a registered `Fn`, so it doesn't move the count.)
- **Additions:** algebra `filter`/`map`/`reduce`/`augment` (+4, less any `grep`/`select` absorption it later claims), platform `notify`/`diff`/`job`/`browse`/`entity` (+5), teach/ask `teach`/`ask` (+2), style `style`/`edit` (+2), travel `travel` (+1). mac-LLM and Workflows add 0.

Net landing ≈ **95–98** depending on the algebra absorption count — immaterial under the lifted cap; the load-bearing invariant is that no deletion is double-counted and each shared module has one owner (the table above).

**Double-count reconciliations (the refinement pass closed these — status noted):**
- `product_search` — RESOLVED: one deletion, gated on `search(backends:'retail')`; render retailers stay reachable by name so no capability regression.
- `preferences` — RESOLVED: one deletion; teach/ask migrates `sux:prefs:*`→voice-scoped `_kb`, style owns the voice kind.
- `_filter.ts` — RESOLVED: search owns the grammar; the `paths` export + synonym lexer + prefix-`exists` are co-signed in both search.md (§7, "Co-signed changes to algebra.md") and algebra.md (R19).
- `Fn.staleGrace`/`width`/`records` (+ `Fn.cost` widened to a function) — one `registry.ts` definition; search/shop/algebra reference the same fields.
- The `job`/Workflows/travel-`track` registry is one `sux:job:` namespace (platform D-proactive owns it; travel `track` and Workflows enqueue onto it).

## Master build sequence (the assembled cross-doc DAG)

The per-doc build orders compose into one acyclic sequence; the load-bearing cross-doc edges (verified no cycle):

1. **algebra cycle 0** — `_records.ts` + `dig` + `_fanout.ts` + env-clone `_budget` ledger + `registry.ts` `Fn` fields. *(nothing depends on search/shop yet.)*
2. **search cycle 0** — `_filter.ts` grammar on the co-signed freeze. → **algebra's `filter` fn (cycle 1) rebases onto these exports.**
3. **algebra cycle 1** — `filter`/`reduce`/`map`/`save` (imports `_filter.ts` from step 2).
4. **shop step 1** — extract `_retail_fanout.ts` (behavior-neutral). → **search cycle 4 (retail group) and algebra's `price` augmenter both consume it.**
5. **search cycles 1–3** — web/research/social groups on `_fanout` + `_filter` (delete `web_search`).
6. **search cycle 4** — retail group via `_retail_fanout` (step 4) + `rating`/`reviews` lift; gate-delete `product_search`.
7. **shop steps 2–4.5** — `_compare.ts` + `searchByTerm` on `_retail_fanout`. → **`searchByTerm` feeds algebra's `augment` cycle (step 8).**
8. **algebra cycle 7** — `augment` + adapter catalog (imports `searchByTerm` from step 7).
9. **teach/ask, style/edit** — on `_kb` (independent of search/shop; teach lands first per `_kb` ownership).
10. **platform** — `notify`→`diff`→`job`→mac-LLM→`browse`→Workflows+`entity`.
11. **travel** — consumes the `sux:job:` registry (step 10) for `track`; otherwise independent.
12. **jmap** — fully independent (only the standard `Fn`/`smartFetch`/`OAUTH_KV` conventions + a `FASTMAIL_TOKEN` secret); ships anytime. Its `_jmap.ts` session/limit engine is self-contained; its `records`-shaped output composes into the algebra (`map`/`filter`/`reduce` over `Email/query` results) once Phase 1 lands.

The only hard ordering constraints are the four import edges (steps 2→3, 4→6, 4→8, 7→8); everything else parallelizes across branches. `jmap` (12) has no substrate dependency and can land first if email is the priority.

## Related

- [[SUX]]
- [[ITERATION-LOG]]
- [[Parked-Retrieval-MOC]]
- [[two-hard-facts]]
- [[algebra]]
