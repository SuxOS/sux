// Vault folder-name constants, factored out so a per-environment override is a
// one-line env flip instead of a repo-wide grep/replace. Defaults are the
// SuxOS/vault numbered-taxonomy names (the colinxs/vault taxonomy migration —
// Daily/ → 06-daily/, Inbox/ → 00-inbox/ — has landed); the env vars remain an
// escape hatch for pointing at a differently-shaped vault.

import type { RtEnv } from "../registry";

/** The daily-note folder (default "06-daily"). Override via VAULT_DAILY_DIR. */
export const vaultDailyDir = (env: RtEnv): string => env.VAULT_DAILY_DIR?.trim() || "06-daily";

/** The capture/intake folder (default "00-inbox"). Override via VAULT_INBOX_DIR. */
export const vaultInboxDir = (env: RtEnv): string => env.VAULT_INBOX_DIR?.trim() || "00-inbox";
