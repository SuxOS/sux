# sux — Claude Code plugin

Registers the **remote** sux MCP server as an OAuth-gated connector in Claude Code, and
ships the `sux` routing skill so Claude knows which of the ~80 sux functions to reach for.

- **What it connects to:** `https://sux.colinxs.workers.dev/mcp` (streamable HTTP / SSE, GitHub OAuth)
- **What you get:** the full sux toolset (web search, residential scrape/render, extract/convert,
  Workers-AI text, retail + scholarly APIs, storage) as MCP tools, plus a `/sux:sux` skill.

## What's in here

```
claude-code-plugin/
├── .claude-plugin/
│   └── plugin.json        # plugin manifest (name, metadata, points at .mcp.json)
├── .mcp.json              # remote MCP server registration (type: http, url, OAuth)
└── skills/
    └── sux/
        └── SKILL.md        # routing skill (namespaced as /sux:sux)
```

The MCP registration is deliberately minimal — no headers/tokens are baked in. sux uses
GitHub OAuth with **dynamic client registration** (`/register`, `/authorize`, `/token`),
so Claude Code runs the OAuth flow for you the first time a tool is called (it detects the
`401 Unauthorized` from `/mcp` and prompts you in `/mcp`).

## Install

### Option A — test locally (no marketplace)

From the repo root:

```bash
claude --plugin-dir ./dist/claude-code-plugin
```

Then, inside Claude Code, authorize the connector:

```
/mcp
```

Select **sux → Authenticate** and complete the GitHub OAuth flow in your browser. After it
finishes, the sux tools are live. Try the skill with `/sux:sux`.

### Option B — install from a marketplace

If this plugin is published to a marketplace (e.g. a git repo containing a
`.claude-plugin/marketplace.json`):

```
/plugin marketplace add colinxs/sux-mcp
/plugin install sux@<marketplace-name>
```

Then authorize with `/mcp` as in Option A.

## Verify

- `/mcp` shows `sux` as **connected** after auth.
- Ask Claude to "search the web with sux for …" or "scrape <url> with sux" — the call
  should route through the `sux` MCP tools.
- The server's own health endpoint is public: <https://sux.colinxs.workers.dev/health>.

## Notes / limitations

- **OAuth is interactive.** In a non-interactive `claude -p` / Agent SDK run there's no
  `/mcp` panel, so first-time auth must be done once from an interactive session
  (`/mcp` or `claude mcp login sux`). Tokens are cached afterward.
- **Transport:** the manifest uses `"type": "http"` (streamable HTTP; `streamable-http` is
  an accepted alias). sux responds over SSE. If a future client needs the legacy SSE
  transport explicitly, change the entry to `"type": "sse"` with the same `url`.
- **Schema caching:** MCP clients cache `tools/list`. After a schema-changing sux deploy,
  reconnect the connector (`/mcp` → reconnect) to refresh tool definitions.

## Docs referenced

- Claude Code plugins: <https://code.claude.com/docs/en/plugins>
- Plugins reference (manifest + `.mcp.json`): <https://code.claude.com/docs/en/plugins-reference>
- MCP (remote HTTP/SSE config + OAuth): <https://code.claude.com/docs/en/mcp>
