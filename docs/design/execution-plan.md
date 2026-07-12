---
title: sux — execution plan (the one big plan, live)
status: executing
---

# Execution plan — serial chunks, each internally parallel, land green + deploy before next

Anchored to `north-star.md`. Mode: **maximally deployed, maximally secure, minimally PR-staged,
bounded deadline.** Autonomy granted. Guardrails: keep `main` green; never touch creds/secrets or
irreversible real-account acts unattended; reversible-only for anything auto-applied.

## Config (locked with Colin)
- **Notification channel:** append to the vault **Daily/<date>.md** — a `sux` section: did / suggests / questions / undo handles.
- **Depth:** all 6 chunks.
- **Models — smart router:** each task routed cheapest-sufficient → rules → **Workers-AI embeddings** (classification/similarity/tone, edge, private, learns from labels via kNN) → **frontier API** (hard low-volume synthesis: onboard/therapy). Data stays local unless the task truly needs the frontier; frontier egress minimized + fenced.
- **Deploy policy:** merge+deploy fixes/refactors/cleanup; **PR** new features (build if high-value) + anything security-risky.
- **Refused/held (security):** remote-exec shell (not built; at most allowlisted file-ops, PR-only); tailnet-only render migration (PR; only HMAC ts-freshness ships); no secret rotation.

## Chunks
1. **Design-review fixes** — ultra-flow `w31ugd57p`: 5 parallel clusters (infra-resilience #46, render-unify+HMAC-freshness #43, registry-surface+`sux`-verb #44, files-vault #45, mail-caldav) + live bot-detection + design-review-round-2. Verify each verdict → merge safe → deploy.
2. **Front-door + one connector** — consolidate shop/search/fetch/research/media; `surface` field hides leaves behind ~12 front verbs + `fn` escape; `sux` root verb self-describes (mobile-safe); **retire** mail/vault/files namespace connectors + plugins (keep routes dormant). Deploy.
3. **Smart-guards generalized** — stage-by-default + `!`/force override on ALL irreversible/outward acts (send, deletes, Mode-B writes, masked/cal/contact deletes); reversible-only auto; agent-side sentiment-pause + typo/recipient/attachment lint (pre-send conscience). Deploy.
4. **Stateless-learning substrate** — learned-prefs store (KV) + vault-KB write-hooks (save-on-search, save-on-learn) + embeddings store + kNN classify; `recall` reads it back. The vector/labeled set IS the learned model. Deploy.
5. **`mail_triage` bot** — cron: pull new mail (last-seen idempotent) → smart-router classify (embeddings+kNN over learned categories) → **autonomy ON, reversible-only** (label/move/junk-teach, never delete), **confidence-gated** (uncertain → suggest), fully **logged + bulk-undo**, first cycle reviewable, cost-bounded. Digest → daily note. Deploy live.
6. **Self-improvement loop** — recurring design-review cron consumes `issue`/`suggest` feedback → builds findings green → **auto-merge+deploy fixes/refactors/cleanup**, **PR features (if high-value)**, always-PR security. Kill-switch + rate cap. Self-deploying ⇒ PR the loop itself for Colin.

## Don't-forget connective tissue (the sins-of-omission list)
Digest channel (ch.4/5) · learned-prefs store designed FIRST (ch.4) · correction→learning + bulk-undo (ch.5) · idempotent+cost-bounded cron (ch.5) · identity resolution across mail/contacts/calendar (ch.4) · bulk-work > 60s → Queues/Workflows (ch.4/5, else silent truncation).

## Pruned as cruft (not building)
Algebra substrate, un-parked verb program, uw directory, unused per-store scrapers, speculative front-verbs without a caller. Flagship `onboard` (self-model + therapy synthesis) = capstone, PR-only.
