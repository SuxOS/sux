# sux — Claude Desktop

sux is a **remote, OAuth-gated** MCP server (`https://suxos.net/mcp`).
Claude Desktop offers two ways to connect it. **Option A (native custom connector) is the
recommended path** — it's built for exactly this case. The bundled `.mcpb` in Option B
exists only because `.mcpb`/`.dxt` bundles were designed for *local* servers, so it wraps
a local stdio→remote bridge.

---

## Option A (recommended) — native Custom Connector

Claude Desktop can talk to a remote MCP server directly, no bundle required.

1. Open **Claude Desktop → Settings → Connectors**.
2. Click **Add custom connector**.
3. **Name:** `sux`  ·  **Remote MCP server URL:** `https://suxos.net/mcp`
4. Leave **Advanced settings** (OAuth Client ID / Secret) **empty** — sux supports OAuth
   *dynamic client registration* (`/register`), so no pre-provisioned client is needed.
5. Click **Add**, then complete the GitHub OAuth sign-in when prompted.

The sux tools appear under the `sux` connector once authorized.

**Requirement / limitation:** custom connectors connect from **Anthropic's cloud**, not
from your local machine, so the server must be reachable over the public internet — sux is
(it's a public Cloudflare Worker), so this works. Available on Free/Pro/Max/Team/Enterprise
(Free is limited to one custom connector).

> Note: a Claude Desktop update on 2025-12-18 briefly broke OAuth 2.0 for custom
> connectors. If Option A fails to authorize, update Claude Desktop to the latest version,
> or fall back to Option B.

---

## Option B (fallback) — `.mcpb` bundle via `mcp-remote`

`.mcpb` (MCP Bundle, formerly `.dxt` Desktop Extension) **only supports local stdio
servers** — there is no native remote-URL field in the manifest. To ship sux as a bundle we
wrap [`mcp-remote`](https://www.npmjs.com/package/mcp-remote), a small npm bridge that
speaks stdio to Claude Desktop and proxies to the remote sux MCP, handling the OAuth
browser flow locally and caching tokens under `~/.mcp-auth/`.

### Requirements

- **Node.js ≥ 18** on the machine (the bundle runs `npx -y mcp-remote …`).
- Internet access for the OAuth browser window on first run.

### Build the bundle

Install the packer once, then pack this directory:

```bash
npm install -g @anthropic-ai/mcpb   # provides the `mcpb` CLI
cd dist/desktop-extension
mcpb pack .                          # produces sux.mcpb
```

### Install

Double-click `sux.mcpb` (or **Claude Desktop → Settings → Extensions → Install from
file…**). Confirm the pre-filled **sux MCP URL** (`https://suxos.net/mcp`)
and enable it. On first tool use, a browser window opens for GitHub OAuth; approve it once.

### Equivalent manual config

If you'd rather skip the bundle, add this to `claude_desktop_config.json`
(**Settings → Developer → Edit Config**) — it's what the bundle runs:

```json
{
  "mcpServers": {
    "sux": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://suxos.net/mcp"]
    }
  }
}
```

Restart Claude Desktop, then approve the OAuth window on first use. To force a transport,
append `--transport http-only` (or `sse-only`) to the args.

---

## What's in here

```
desktop-extension/
├── manifest.json   # .mcpb manifest (manifest_version 0.3) wrapping mcp-remote
└── README.md
```

## Limitations summary

- **`.mcpb`/`.dxt` cannot bundle a remote MCP directly** — remote support comes only via
  the `mcp-remote` stdio bridge (Option B) or the native custom-connector UI (Option A).
- **Option A runs OAuth from Anthropic's cloud; Option B runs it locally** in your browser
  and caches tokens on your machine. Choose B if you want the token to stay local, or if
  the native connector OAuth is having issues.
- Both require an interactive first-run to complete OAuth.

## Docs referenced

- MCP Bundles / manifest schema: <https://github.com/anthropics/mcpb> ·
  <https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md>
- Custom connectors (remote MCP) in Claude Desktop:
  <https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp>
- `mcp-remote` bridge: <https://www.npmjs.com/package/mcp-remote>
