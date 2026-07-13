# dist/ — distributable packagings of sux

sux is a remote, OAuth-gated MCP server (Cloudflare Worker) at
`https://suxos.net/mcp` exposing ~80 edge functions. This directory holds
three ready-to-ship packagings. Each is self-contained with its own README.

| Artifact | Directory | What it is |
|---|---|---|
| **Claude Code plugin** | [`claude-code-plugin/`](./claude-code-plugin/) | Registers the remote sux MCP connector (`type: http`, OAuth) **and** bundles the routing skill. Install with `claude --plugin-dir` or a marketplace. |
| **Claude Desktop** | [`desktop-extension/`](./desktop-extension/) | Two paths: (A, recommended) native custom connector via the sux URL; (B, fallback) a `.mcpb` bundle wrapping `mcp-remote` to bridge the remote MCP to local stdio. |
| **Skill** | [`skill/`](./skill/) | Standalone, improved copy of the `sux` routing skill (`SKILL.md`). |

## Key facts (verified against current docs)

- **Claude Code plugins** live in a directory with `.claude-plugin/plugin.json`; a
  plugin-root `.mcp.json` registers MCP servers. A **remote** server uses
  `{ "type": "http", "url": … }` (`streamable-http` is an accepted alias; `"sse"` also
  valid). No token is baked in — Claude Code runs OAuth on the `401` from `/mcp`.
- **Claude Desktop** connects remote OAuth MCP servers **natively** via *custom
  connectors* (URL + optional OAuth client id/secret). sux needs neither because it
  supports OAuth *dynamic client registration* (`/register`).
- **`.mcpb`/`.dxt` bundles are local-stdio only** — they cannot point at a remote URL, so
  the bundle wraps `mcp-remote` (needs Node ≥ 18) to bridge remote→stdio.

All JSON manifests in this tree parse cleanly (`node -e JSON.parse`).

## sux OAuth endpoints (from `sux/src/index.ts`)

`apiRoute: /mcp` · `authorize: /authorize` · `register: /register` (dynamic client
registration) · `token: /token`. GitHub is the identity provider. Public, unauthenticated
health check: <https://suxos.net/health>.
