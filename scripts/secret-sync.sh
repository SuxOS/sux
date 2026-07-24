#!/usr/bin/env bash
# secret-sync.sh — push credential(s) from 1Password (source of truth) to the sux Worker.
#
# op migrated FLAT -> NESTED (2026-07): a value now lives at op://Secrets/<ITEM>/<field>,
# so a Worker-secret name is NOT its op path. scripts/secrets.map owns that mapping — this
# script never guesses. GitHub Actions is no longer synced here: CI reads op directly at
# runtime via 1password/load-secrets-action (see docs/secrets.md § CI).
#
# Usage:
#   scripts/secret-sync.sh <WORKER_SECRET>        # sync one
#   scripts/secret-sync.sh --all                  # sync every op:// credential in the map
#   scripts/secret-sync.sh <NAME|--all> --dry-run # show what would happen, touch nothing
#
# Prereqs: `op` signed in, `wrangler` authed (Workers:edit). Values are piped op->wrangler;
# nothing is ever printed (Worker/GitHub stores are write-only anyway).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
MAP="$HERE/secrets.map"
[ -f "$MAP" ] || { echo "missing $MAP" >&2; exit 1; }

DRY=0; NAME=""
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --all)     NAME="--all" ;;
    -*)        echo "unknown flag: $a" >&2; exit 2 ;;
    *)         NAME="$a" ;;
  esac
done
[ -n "$NAME" ] || { echo "usage: secret-sync.sh <WORKER_SECRET> | --all [--dry-run]" >&2; exit 2; }

ref_for() { awk -F'\t' -v n="$1" '$0 !~ /^[[:space:]]*#/ && $1==n {print $2; exit}' "$MAP"; }

sync_one() {
  name="$1"; ref="$(ref_for "$name")"
  case "$ref" in
    "")         echo "x $name: not in secrets.map" >&2; return 1 ;;
    @switch*)   echo ". $name: @switch — set by hand, not synced" ; return 0 ;;
    @setting*)  echo ". $name: @setting — belongs in wrangler.jsonc [vars]" ; return 0 ;;
    @missing*)  echo "x $name: @missing from op — re-source from origin" >&2; return 1 ;;
    @confirm*)  echo "x $name: @confirm — verify op ref in secrets.map first" >&2; return 1 ;;
    op://*)
      if [ "$DRY" = 1 ]; then echo "would: $name <- $ref"; return 0; fi
      op read "$ref" | npx wrangler secret put "$name" --config sux/wrangler.jsonc >/dev/null \
        && echo "ok $name <- $ref" || { echo "x $name: put failed" >&2; return 1; } ;;
    *) echo "x $name: unrecognized map value" >&2; return 1 ;;
  esac
}

if [ "$NAME" = "--all" ]; then
  rc=0
  for n in $(awk -F'\t' '$0 !~ /^[[:space:]]*#/ && $2 ~ /^op:\/\// {print $1}' "$MAP"); do
    sync_one "$n" || rc=1
  done
  exit $rc
else
  sync_one "$NAME"
fi
