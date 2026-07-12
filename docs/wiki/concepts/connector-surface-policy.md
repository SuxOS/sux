---
title: Connector Surface Policy
status: shipped
cluster: namespaces
type: concept
tags: [sux, namespaces, shipped]
updated: 2026-07-11
related: ["[[namespace-architecture]]", "[[oauth-gate]]", "[[vault-stack]]", "[[three-mcps]]", "[[Namespaces-MOC]]"]
---

# Connector Surface Policy

**Source:** [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json), [`plugins/sux-router/`](../../../plugins/sux-router/), [`plugins/sux-life/`](../../../plugins/sux-life/)

The `sux` marketplace ships **two plugins**, but only one carries a connector. `sux-router` bundles the **one connector** (`/mcp`) **and** the `sux` routing skill: a single OAuth-gated front door for the universal verbs (web search, scraping/rendering, papers, shopping, documents, transforms, pipe/batch) *and* the personal namespaces, reached through `vault_`/`mail_`/`files_`/`cal_`/`contact_` verbs plus `recall` and the `fn` escape. The former per-domain connectors (`/vault/mcp`, `/mail/mcp`) are **retired into this single front door**; their routes stay dormant on the Worker. `sux-life` is a **skill-only plugin** — the `life` memory discipline (capture → triage → link → retrieve → consolidate) layered *on top of* sux-router's verbs; it declares no `mcpServers` of its own and rides sux-router's connector. Everything rides the same [[oauth-gate]] and the same `apiRoute` array, so adding a namespace costs a new dormant route, not new auth infrastructure — one Worker, one OAuth, one connector.

## Connectors sync; skills don't — the mobile split

The load-bearing rule (see the `sux-connector-surface-policy` memory): **a remote connector carries tools, not skills.** That splits availability by *what* the artifact is, not just by client:

- The **connector** (the `/mcp` MCP tools) is account-level. Added once via Settings→Connectors, it syncs everywhere — **web, mobile**, Desktop, Cowork, CLI. So on a phone you get the raw sux tools (`vault_`, `mail_`, `search`, `ingest`, `recall`, `fn`, …).
- A **skill** (`sux-router`'s `sux` skill, `sux-life`'s `life` skill) loads **only where its plugin is installed + enabled** — Code/CLI (local marketplace) and Cowork (`enabledPlugins`). Skills do **not** travel with the synced remote connector, so on **web/mobile you get the tools but neither skill**.

This answers the router-vs-life question directly: on mobile the **connector is present but the `life` skill is not**, and it structurally *can't* be — `sux-life` is skill-only, so there is nothing of it to sync to a tools-only surface. This is a deliberate split, not a bug:

- **`sux`'s routing survives on mobile anyway**, because sux-router mirrors it *server-side*: the connector self-describes through the `sux`/`fn` front verbs and `preferences`, so intent→tool routing still works without the local skill.
- **`life`'s memory discipline does not** — it is pure prompt-side guidance with no server mirror. On mobile the model can still call `vault_capture`/`mail_search` by hand, but the capture→consolidate loop, the memory frontmatter contract, and the citation discipline only load where the sux-life plugin is enabled.

**Keeping them consistent:** install `sux-life` **wherever `sux-router` is a local/enabled plugin** (Code/CLI/Cowork), so the memory skill is present on every surface that loads skills at all. There is nothing to toggle for mobile/web — the memory *discipline* is deliberately Code/CLI/Cowork-only, while the underlying stores stay reachable everywhere through the synced connector. If you want the `life` loop on a phone, drive it from a Cowork/Code session (where the plugin is enabled) rather than the mobile app's bare connector.

Both plugins are version-locked to the marketplace (`sux-router` and `sux-life` at the versions in [`marketplace.json`](../../../.claude-plugin/marketplace.json)); each declares `"skills": "./skills/"` so the skill loads on enable.
