---
title: sux as a personal agent — architecture + roadmap
status: designed
cluster: agent
type: roadmap
summary: "How sux grows from a tool/connector suite into a proactive personal agent that perceives across your life, decides what's worth doing, proposes gated actions, acts only through a fail-closed approval kernel, and learns from your approvals. The core move is generalizing sux's EXISTING gate/autonomy machinery — not building a new agent from scratch."
tags: [sux, agent, roadmap, autonomy, gates]
updated: 2026-07-13
related: ["[[master-plan]]", "[[improvement-backlog]]", "[[autonomous-pipeline]]"]
---

# sux as a personal agent

## The one idea

sux already contains the **entire kernel of a personal agent** — it just isn't
unified or pointed outward yet. The expansion is not a rewrite. It is:

1. **Generalize** the scattered gate/autonomy pieces into one **proposal kernel**.
2. **Add proactivity** — an **agenda loop** that senses across your life and
   decides what's worth doing ("figure out what to do").
3. **Add an approval surface** — a **proposal inbox** where the agent's
   suggestions land for one-tap approve / reject / snooze.
4. **Plug in more senses** — MyChart, email backlog, Monarch signals, notes.
5. **Close the loop** — approvals/rejections become learning signal so the
   proposals get better and quieter over time.

Everything in (1) is ~80% built. (2) and (3) are the genuinely new pieces.
(4) is "wire more sources into the existing kernel." (5) reuses the existing
feedback/preferences machinery.

## What already exists (the kernel we generalize)

| Primitive | Where | What it already does |
|---|---|---|
| **`staged()` + `STAGE_KINDS`** | `stage.ts` | Propose→commit substrate. Any side-effect can return `{preview, commit_token}` WITHOUT mutating; a second call with the token commits, iff unspent + unexpired + payload-hash-matched. **Fail-closed by annotation** — a `kind` with no `STAGE_KINDS` entry throws rather than auto-run. This IS "I suggest → you do the correct thing, gated." |
| **Conscience-lint** | `stage.ts:80` | Advisory second opinion on a staged payload — recipient sanity, typo'd addresses, tone. Rides on every `StageResult` as `advisory[]`. This is the "check email tone" gate, already generalized past email. |
| **`allow_send` / `allow_destroy`** | `_jmap.ts`, jmap | Credential-layer gates: send/destroy/vacation/forwarding are refused unless explicitly allowed. Accidental-misuse guard. |
| **Six fail-closed autonomy loops** | `_mail_triage`, `_briefing`, `_weekly_recall`, `_self_improve`, `_dropbox-full`, `_consolidate` | Uniform shape: `flagOn()` + `hasX(env)` + **dormant by default** + dynamic import + (for weekly) a once-per-ISO-week ledger. Each rides the cron tick. |
| **The trust ladder** | `autonomy_status` | Every surface has a mode: **dormant → suggest-only → armed-reversible → armed-full**. Each step is a separate env flag; reversible acts arm before irreversible ones. |
| **`autonomy_status`** | `autonomy_status.ts` | Read-only mirror of exactly what's armed right now (booleans, never secret values). The transparency/consent surface. |
| **`ledger()`** | `ledger.ts` | KV idempotency — "have I already acted on X?" so sweeps converge on re-run. |

The design principle to preserve at all costs: **git is the undo, the gate is
the net, nothing acts without passing the gate, and everything is dormant until
you deliberately arm it.**

## Architecture — four layers

```
  SENSE ──────────► DECIDE ──────────► PROPOSE ──────────► ACT ──────────► LEARN
  (sources)         (agenda loop)      (proposal inbox)     (gate kernel)   (feedback)

  mail, calendar    _agenda.ts:        proposals fn +       staged()+       approvals →
  MyChart, Monarch  fan across         a vault-backed       conscience →    preferences +
  vault, tasks,     senses, detect     queue Colin          commit or       feedback queue
  files             actionable         approves/rejects     await-approval  → better ranking
                    situations,        /snoozes
                    rank, emit
                    PROPOSALS
```

### Layer 1 — Proposal kernel (generalize what exists)

Elevate `staged()` + conscience-lint into **the** universal act-on-behalf path.
Every capability that wants to do something for Colin emits a **Proposal**:

```
Proposal = {
  id, source, kind,            // e.g. source:"mail", kind:"archive_newsletter"
  intent,                      // human-readable: "Archive 14 GitHub CI notifications"
  payload,                     // the exact args a commit would run
  reversible: boolean,         // reversible ops can auto-run when armed; irreversible always stage
  stakes: "low"|"med"|"high",  // gates the default posture
  advisory,                    // conscience-lint notes
  evidence,                    // why: the messages/rows/notes that triggered it
  status: proposed|approved|rejected|snoozed|committed|expired,
}
```

The kernel's rule (already the `staged()` rule, made universal):
- **reversible + low-stakes + surface armed** → auto-run, log the outcome.
- **irreversible OR high-stakes OR surface not armed** → stage for approval.
- **no annotation** → fail closed (never silently act).

This is a thin generalization of `STAGE_KINDS` + a proposal record. No new trust
model — the SAME ladder, now uniform across every source.

### Layer 2 — Agenda loop (`_agenda.ts`) — "figure out what to do"

A new fail-closed cron loop (identical shape to the existing six). Each tick it
fans across the armed senses and runs **detectors** — cheap, mostly rule-based
functions that turn raw source state into candidate proposals:

- mail: unreplied-important, newsletter-pileup, spam, unfiled receipts
- calendar: today's agenda, prep-needed, conflicts
- Monarch: bill due, unusual charge, low balance, subscription creep
- MyChart: new secure message, new result, appointment change, Rx ready
- vault: stale/unverified note, likely-duplicate, unfiled capture (via consolidate)
- tasks: overdue, due-today

Detectors are ranked (stakes × freshness × your past approval rate for that kind)
and de-duped against the `ledger` so the same situation isn't re-proposed every
tick. Output: a small ranked proposal set into the queue. **Propose-only by
default; nothing it emits acts without the kernel gate.**

### Layer 3 — Proposal inbox

Where proposals land for Colin. Minimum viable: a single vault note
`Agenda/<date>.md` (git-reversible) + a section in the morning `briefing`. As
surfaces come online: a `proposals` fn (`list` / `approve` / `reject` / `snooze`)
so approval is one call, and once JMAP PushSubscription (#213/PR #223) + outbound
push (#219) land, proposals can reach the phone in near-real-time.

Approve → the kernel commits the payload through the gate. Reject/snooze → a
learning signal.

### Layer 4 — Learning

Approvals/rejections feed the existing `_self_improve` feedback queue +
`preferences`. A proposal kind that's rejected 3× stops being auto-proposed
(raises its threshold); a kind approved every time earns a higher default
posture suggestion (surfaced in `autonomy_status`, never self-armed). The agent
gets quieter and more accurate without ever expanding its own authority.

## Workstream decomposition

Phased by dependency and safety. Every item is **fail-closed / dormant by
default**; arming is always a separate, deliberate Colin action.

### Phase 0 — Kernel (foundation)
- **W1 · Proposal kernel** — generalize `staged()` into `propose()` + a
  KV/vault-backed proposal queue + a `proposals` fn (list/approve/reject/snooze).
  SAFE: propose-only; acting still goes through the existing gate. `[S–M]`
- **W2 · Agenda loop** (`_agenda.ts`) — cron-driven sense→rank→propose across
  already-connected sources. Dormant by default. SAFE. `[M]`

### Phase 1 — Immediate wins on existing connectors
- **W3 · Email backlog cleanup** — extend `mail_triage` from "new mail only" to
  a bounded sweep of the *existing* backlog, reversible-only ops. (Colin's inbox
  is overloaded *now* — 50+ items, CI-notification pileup, real payment-alert
  storm.) SAFE (reversible). `[S–M]`
- **W4 · Cheap spam classifier** — add a spam category to the existing
  rule-based `classifyMessage` (sender-reputation heuristics, list-unsubscribe,
  bulk markers); escalate ONLY ambiguous cases to Workers-AI `llama-3.2-3b`
  (cheapest tier — never Opus/Sonnet for classification). CHEAP by design. `[S]`
- **W5 · Notes/knowledge into the agenda** — `consolidate` (shipped) +
  `weekly_recall` (shipped) already do the work; wire their findings (stale,
  duplicate, unfiled) into the agenda loop as proposals. `[S]`

### Phase 2 — New / deepened senses
- **W7 · Monarch signals** — `monarch` is already read-only; add detectors that
  turn balances/transactions/budgets into proposals (bill due, unusual charge,
  low balance, subscription creep). Read-only source; sux NEVER moves money. `[S–M]`
- **W6 · MyChart** — auth portal, JS-heavy → needs the `render:mac` ladder +
  secure credential handling (Colin enters creds; sux never stores plaintext).
  Read-only first: surface new secure messages / results / appointment changes /
  Rx-ready as proposals. Highest effort, security-sensitive — its own design
  pass before any code. `[L]`

### Phase 3 — Learning + polish
- **W8 · Approval→learning** — approvals/rejections tune proposal ranking +
  `preferences`; `autonomy_status` surfaces "this kind is always approved —
  consider arming" without ever self-arming. `[M]`

## Recommended sequence

**W4 → W3** first (spam classifier + backlog cleanup — the pain that exists
*today*, safe, cheap, builds on `mail_triage`, visible within a day), **then W1 →
W2** (the kernel + agenda loop that unify everything), **then W7** (Monarch
signals — timely given tonight's payment-alert storm), **then W5** (notes), **then
W6** (MyChart — its own design pass), **then W8** (learning).

Rationale: ship a felt win immediately (a cleaner inbox), then build the
foundation that makes every later source a small plug-in rather than a bespoke
integration. W6/MyChart is deliberately last — it's the only piece needing new
auth/security design.

## Safety principles (non-negotiable, inherited from the existing kernel)

1. **Nothing acts without passing the gate.** Every act-on-behalf routes through
   `staged()`/`propose()`. No annotation → fail closed.
2. **Reversible before irreversible.** Reversible ops (label/move/archive/draft)
   can auto-run when a surface is armed; irreversible ops (send/delete/pay) always
   stage for explicit approval. sux never moves money, never hard-deletes.
3. **Dormant by default.** Every surface ships off; arming is a separate,
   deliberate env flag per surface, per posture level.
4. **Conscience on every proposal.** The advisory lint runs on each staged
   payload — recipient sanity, tone, anomaly — surfaced to Colin before approval.
5. **Full transparency.** `autonomy_status` always reflects exactly what's armed;
   no hidden authority; the agent never expands its own authority (learning only
   *suggests* arming).
6. **Cheapest model that's correct.** Classification/detection is rule-based
   first, Workers-AI `llama-3.2-3b` for ambiguity — never a frontier model to
   sort mail.

## Open questions for Colin (do not block Phase 0/1)

- **Default posture** once armed: propose-only (everything waits for approval) vs.
  auto-run-reversible (labels/moves/archives happen, only irreversible waits)?
  Recommendation: start propose-only, graduate per-surface as trust builds.
- **Proposal inbox medium** you'll actually check: a vault `Agenda/` note, the
  morning briefing, phone push, or a mix? (Push depends on #219.)
- **MyChart** credential handling comfort: app-password/session-cookie in a Worker
  secret vs. a more isolated store? (Gates W6's design.)
