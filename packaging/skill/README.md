# sux — routing skill (distributable copy)

An improved, standalone copy of the `sux` Agent Skill. It teaches an agent how to **route a
task to the right sux function** and lean on `sux/FUNCTIONS.md` as the live catalog, and it
notes the remote-OAuth connector prerequisite.

This is a copy for distribution — the original in-repo skill at
`.claude/skills/sux/SKILL.md` is left untouched.

## What changed vs. the original

- Broadened the routing table to cover functions the original omitted: `render`,
  `find_similar`, `batch_fetch`, `fontcase`, the retail fns (`amazon`, `walmart`,
  `homedepot`, `costco`, `lowes`, `ace`, `kroger`, `bestbuy`, `ebay`, `etsy`), and the
  keyless scholarly/finance/media APIs (`arxiv`, `pubmed`, `crossref`, `openalex`,
  `semantic_scholar`, `clinical_trials`, `stackexchange`, `alphavantage`, `coingecko`,
  `wolfram`, `tmdb`, `youtube`, `nyt`, `guardian`, `places`).
- Added the **fetch-ladder** (direct → `scrape` → `render:cf` → `render:mac`) so the agent
  escalates only as far as bot-detection forces it.
- Added a **connector prerequisite** section (remote OAuth setup) and a `fresh:true`
  cache-bypass note.
- Stopped hardcoding a function count — the count drifts, so the skill points at
  `sux/FUNCTIONS.md` (regenerate with `npm run docs`) as the source of truth.

## Install

**As a personal skill** (available in every project):

```bash
mkdir -p ~/.claude/skills/sux
cp dist/skill/SKILL.md ~/.claude/skills/sux/SKILL.md
```

**As a project skill** (checked into a repo):

```bash
mkdir -p .claude/skills/sux
cp dist/skill/SKILL.md .claude/skills/sux/SKILL.md
```

**Or via the plugin** — the same `SKILL.md` is already bundled in
`dist/claude-code-plugin/skills/sux/`, so installing that plugin gives you the connector
*and* the skill (namespaced `/sux:sux`).

Run `/reload-plugins` (or restart) to pick it up. The skill is model-invoked from its
`description`, or you can trigger it explicitly.

## Contents

```
skill/
├── SKILL.md   # the routing skill (frontmatter name/description + routing guidance)
└── README.md
```
