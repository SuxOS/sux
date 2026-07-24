#!/usr/bin/env bash
# secret-check — audit for secret drift. Lists names (never values) from the
# Cloudflare Worker and GitHub Actions stores and diffs them against the expected
# set below, so a missing/forgotten secret surfaces before a bot silently breaks.
# Names only — safe to run anywhere. Portable (bash 3.2 / macOS).
set -euo pipefail

# --- expected sets (space-separated; keep in sync with docs/secrets.md) ---
WORKER_REQUIRED="ALLOWED_GITHUB_LOGIN COOKIE_ENCRYPTION_KEY GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET GITHUB_TOKEN \
KAGI_API_KEY BRAVE_API_KEY EXA_API_KEY TAVILY_API_KEY GOOGLE_MAPS_KEY NCBI_API_KEY STACKEXCHANGE_KEY \
FASTMAIL_TOKEN FASTMAIL_CALDAV_USER FASTMAIL_APP_PASSWORD DROPBOX_APP_KEY DROPBOX_REFRESH_TOKEN \
TODOIST_TOKEN CONTROLD_API_TOKEN KROGER_CLIENT_ID KROGER_CLIENT_SECRET \
TAILSCALE_OAUTH_CLIENT_ID TAILSCALE_OAUTH_CLIENT_SECRET TAILSCALE_TAILNET TAILSCALE_PROXY_SECRET TAILSCALE_PROXY_URL \
GRAFANA_LOKI_TOKEN GRAFANA_LOKI_URL GRAFANA_LOKI_USER \
OBSIDIAN_REMOTE_KEY OBSIDIAN_REMOTE_URL OBSIDIAN_VAULT_REPO HEALTH_INGEST_TOKEN"

# Optional (feature-gated; absent == that feature simply off — not an error):
WORKER_OPTIONAL="MAIL_TRIAGE_ENABLED MAIL_TRIAGE_ACT SELF_IMPROVE_ENABLE SELF_IMPROVE_PR SELF_IMPROVE_AUTOMERGE \
SELF_IMPROVE_KILL SELF_IMPROVE_REPO SUX_CRON_TOKEN UNLOCKER_API_URL UNLOCKER_API_KEY DROPBOX_APP_SECRET DROPBOX_TOKEN \
DROPBOX_FULL_REFRESH_TOKEN DROPBOX_FULL_APP_KEY DROPBOX_FULL_TOKEN DROPBOX_FULL_PROTECT_PREFIXES \
BESTBUY_API_KEY EBAY_CLIENT_ID EBAY_CLIENT_SECRET REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET S2_API_KEY \
FACEBOOK_TOKEN YOUTUBE_API_KEY FASTMAIL_ACCOUNT_ID FASTMAIL_SESSION_URL VAULT_TZ \
OBSIDIAN_VAULT_BRANCH OBSIDIAN_VAULT_DIR MONARCH_TOKEN GRAFANA_PROM_URL GRAFANA_PROM_USER \
IMESSAGE_URL IMESSAGE_SECRET COHERE_API_KEY GEMINI_API_KEY"

# Staged-but-intentionally-unused: manifest entries kept even though nothing in
# sux/src references them yet (a key provisioned in 1Password/Cloudflare ahead
# of its feature landing in code, e.g. COHERE_API_KEY/GEMINI_API_KEY per
# docs/secrets.md's 2026-07-22 note and the cross-vendor-token-optimization
# spec) — excluded from check_rtenv_drift's dead-entry report so they don't get
# flagged every run. Drop a name from here once it's actually wired into RtEnv.
STAGED_UNUSED="COHERE_API_KEY GEMINI_API_KEY"

GITHUB_REQUIRED="CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_TOKEN SUX_MCP_URL SUX_MCP_TOKEN CLAUDE_CODE_OAUTH_TOKEN \
SUX_BOT_APP_ID SUX_BOT_PRIVATE_KEY"

contains(){ case " $2 " in *" $1 "*) return 0;; *) return 1;; esac; }

audit(){ # $1 label  $2 actual(newline)  $3 required  $4 optional
  echo "== $1 =="
  local actual; actual="$(printf '%s' "$2" | tr '\n' ' ')"
  local known="$3 ${4:-}"
  local miss="" extra=""
  for k in $3; do contains "$k" "$actual" || miss="$miss $k"; done
  for k in $actual; do contains "$k" "$known" || extra="$extra $k"; done
  if [ -z "$miss" ]; then echo "  ✓ all required present"; else echo "  ✗ MISSING (required):$miss"; fi
  [ -n "$extra" ] && echo "  ? not in manifest (orphan or new — add to docs/secrets.md):$extra" || true
}

# check_rtenv_drift — cross-checks WORKER_REQUIRED/WORKER_OPTIONAL above against
# sux/src/registry.ts's `RtEnv` type (the actual field list the Worker's code
# reads env vars from), so the hand-maintained manifest can't silently drift
# from code reality in either direction. Informational only (no exit-1) — this
# script is read by a human, not a CI gate.
#
# Extraction: finds the `export type RtEnv = Env & TailscaleEnv & { ... };`
# block by brace-depth (NOT a naive `sed -n '/^export type RtEnv/,/^};/p'` —
# that pattern's `/^};/` only matches a column-0 close, but RtEnv's own close is
# tab-indented (`\t};`), so it silently overruns 60+ lines into later unrelated
# types like ToolAnnotations before matching. Brace counting finds the true end
# regardless of indentation.), then greps `NAME:` / `NAME?:` field lines inside
# that range. This intentionally also catches a few non-string binding fields
# (R2, VECTORIZE, ANALYTICS, MCP_RATE_LIMITER, ...) — harmless noise for a
# manifest cross-check, not filtered out.
check_rtenv_drift(){
  echo "== RtEnv cross-check (sux/src/registry.ts) =="
  local reg="sux/src/registry.ts"
  if [ ! -f "$reg" ]; then
    echo "  ? $reg not found (run from repo root) — skipping"
    return
  fi

  local start_line end_line
  start_line="$(grep -n '^export type RtEnv' "$reg" | head -1 | cut -d: -f1)"
  end_line="$(awk '
    /^export type RtEnv/ { inblock = 1 }
    inblock {
      line = $0
      opens = gsub(/{/, "{", line)
      closes = gsub(/}/, "}", line)
      depth += opens - closes
      if (started && depth <= 0) { print NR; exit }
      if (depth > 0) started = 1
    }
  ' "$reg")"
  if [ -z "$start_line" ] || [ -z "$end_line" ]; then
    echo "  ? could not locate the RtEnv type block — skipping"
    return
  fi

  local rtenv_fields
  rtenv_fields="$(sed -n "${start_line},${end_line}p" "$reg" \
    | sed -E 's/^[[:space:]]+//' \
    | grep -oE '^[A-Z][A-Z0-9_]*\??:' \
    | sed -E 's/[?:]+$//' | sort -u | tr '\n' ' ')"

  local manifest="$WORKER_REQUIRED $WORKER_OPTIONAL"
  local gaps="" dead=""

  for f in $rtenv_fields; do
    contains "$f" "$manifest" || gaps="$gaps $f"
  done

  for k in $manifest; do
    contains "$k" "$rtenv_fields" && continue
    contains "$k" "$STAGED_UNUSED" && continue
    grep -rq "$k" sux/src 2>/dev/null && continue
    dead="$dead $k"
  done

  if [ -z "$gaps" ]; then echo "  ✓ every RtEnv field is in the manifest"; else echo "  ? RtEnv fields missing from manifest (live in code, blind spot — add to WORKER_REQUIRED/OPTIONAL):$gaps"; fi
  if [ -z "$dead" ]; then echo "  ✓ no likely-dead manifest entries"; else echo "  ✗ likely-dead manifest entries (not in RtEnv, zero refs in sux/src):$dead"; fi
  [ -n "$STAGED_UNUSED" ] && echo "  (staged-but-unused, excluded from the dead-entry check above: $STAGED_UNUSED)"
}

worker_actual="$(npx wrangler secret list --config sux/wrangler.jsonc 2>/dev/null | python3 -c 'import sys,json;print("\n".join(x["name"] for x in json.load(sys.stdin)))' 2>/dev/null || true)"
github_actual="$(gh secret list 2>/dev/null | awk '{print $1}' || true)"

audit "Cloudflare Worker" "$worker_actual" "$WORKER_REQUIRED" "$WORKER_OPTIONAL"
echo
audit "GitHub Actions" "$github_actual" "$GITHUB_REQUIRED" ""
echo
check_rtenv_drift
echo
echo "(names only — no values printed. Fix a gap: value into op, then scripts/secret-sync.sh NAME --worker|--github)"
