---
title: Connector Surface Policy
status: shipped
cluster: namespaces
type: concept
tags: [sux, namespaces, shipped]
updated: 2026-07-09
related: ["[[namespace-architecture]]", "[[oauth-gate]]", "[[vault-stack]]", "[[three-mcps]]", "[[Namespaces-MOC]]"]
---

# Connector Surface Policy

**Source:** [`.claude-plugin/marketplace.json`](../../../.claude-plugin/marketplace.json), [`plugins/sux-router/`](../../../plugins/sux-router/), [`plugins/sux-life/`](../../../plugins/sux-life/), [`sux/src/connectors.ts`](../../../sux/src/connectors.ts)

The `sux` marketplace ships two plugins today, but only **one connector**. `sux-router` installs that connector (`/mcp`) plus the `sux` routing skill: web search, scraping/rendering, papers, shopping, documents, transforms, pipe/batch composition — plus `recall` and the `fn` escape. `sux-life` is a skill-only plugin — the digital-life memory layer — that rides `sux-router`'s front door and ships no connector of its own. The personal namespaces live on their own separate per-domain connectors (`/vault/mcp`, `/mail/mcp`, `/files/mcp`), reached through the `vault_`/`mail_`/`files_`/`cal_`/`contact_` verbs; each was once planned as its own plugin, but none ships one today and they are retired from the default discovery manifest. Their paths still route and stay OAuth-authorized (see [[oauth-gate]]), so they stay reachable via `?all=1` — one Worker, one OAuth, one *advertised* connector. Distribution differs by client: in Claude Code the local marketplace is used directly; in Cowork/Desktop/cloud clients a synced remote connector is used instead, and `enabledPlugins` is deliberately left empty in either case.
