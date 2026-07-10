---
title: Token setup — how to generate each secret (read vs read/write)
status: reference
cluster: infrastructure
type: reference
summary: "Per-service, step-by-step generation of the personal-data tokens the sux namespaces need — where to click, which read-only vs read/write scope to pick, and the exact secret name + command. Values never live in the repo."
tags: [sux, infrastructure, reference, secrets, setup]
updated: 2026-07-10
related: ["[[keys]]", "[[digital-life-spine]]", "[[Infrastructure-MOC]]"]
---

# Token setup — generate each secret

Companion to [[keys]]. This is the **how**: for each service, where to go, what to
click, the **read-only vs read/write** choice, and the command to set it. As always,
**nothing secret lives in the repo** — you paste each value into the hidden prompt of:

```
npm run secret:sux <NAME>      # = wrangler secret put <NAME> --config sux/wrangler.jsonc
```

The prompt reads the value invisibly (not echoed, not in shell history). After setting
mail/files secrets, **reconnect the connector** so the client re-reads `tools/list`.

> **read-only vs read/write, in one line:** a **read-only** token makes the mutating
> tools impossible *at the credential layer* — the safest default when you mostly
> read + compose. Pick **read/write** only for the surfaces you actually want to
> mutate (send mail, move files, complete tasks). You can hold two tokens and swap.

---

## Status & the fast path

- **Fastmail (`FASTMAIL_TOKEN`) — ✅ DONE (2026-07-10):** full read/write scope —
  `mail`, `submission` (send), `contacts`, `maskedemail`. The mail namespace is live,
  send included. *(Housekeeping: an earlier read-only `sux` token can be revoked at
  Fastmail → Settings → Privacy & Security → API tokens → `sux` → Remove access.)*
- **Everything else — needs generating**, each behind its own login/2FA (the sections
  below), then set in one sweep.

**The one-command setter — `scripts/set-secrets.sh`:** once you generate a token and save
it to 1Password, this pipes it into the Worker via `op read | wrangler` — the value is
never printed, never in shell history, Touch-ID-gated:

```
# unlock the 1Password app (Settings → Developer → Integrate with 1Password CLI)
./scripts/set-secrets.sh --dry-run   # check which op:// refs resolve
./scripts/set-secrets.sh             # set every secret that resolves
./scripts/set-secrets.sh --list      # confirm what's set on the Worker
```

Edit the `MAP` at the top of the script so each `op://vault/item/field` points at your
real 1Password item + field. That IS the 1Password integration: **generate → save to
1Password → run the script.** (Login records aren't API tokens — the script only reads
token/key fields you point it at.)

---

## 1. Fastmail — `FASTMAIL_TOKEN` (mail / calendars / contacts, JMAP)

**Where:** [fastmail.com](https://www.fastmail.com) → **Settings → Privacy & Security
→ Connected apps & API tokens → New API token**.

**Steps:** name it `sux`; choose the scopes — **Mail** (add **Calendars** + **Contacts**
if you want `jmap` to reach them). Set access level:

- **Read-only** → `mail_search / mail_read / mail_thread`, calendar/contact reads work;
  `mail_send / mail_draft / mail_archive / mail_masked` are blocked at the credential
  layer (the safe default — recommended for daily use).
- **Read/write** (full) → everything, including send + masked-email create.

Copy the token (shown once). It must be a **JMAP API token**, *not* an "MCP" token.

```
npm run secret:sux FASTMAIL_TOKEN
```

Optional overrides (rarely needed): `FASTMAIL_ACCOUNT_ID`, `FASTMAIL_SESSION_URL`.

---

## 2. Dropbox — `DROPBOX_REFRESH_TOKEN` + `DROPBOX_APP_KEY` + `DROPBOX_APP_SECRET` (files)

**Where:** [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps) →
**Create app**.

**Steps:**
1. **Scoped access** → **App folder** (the built `/files/mcp` is App-folder scoped —
   it can only see `/Apps/<name>/`; scope is the safety wall) → name it → **Create**.
2. **Permissions** tab — check the scopes, then **Submit**:
   - **Read-only:** `files.metadata.read`, `files.content.read`, `sharing.read`.
   - **Read/write:** add `files.content.write` and `sharing.write` (needed for
     `files_write / files_upload / files_delete / files_share`).
3. **Settings** tab → copy **App key** and **App secret**.
4. Mint a **refresh token** (offline OAuth). In a browser, visit — with your App key —
   `https://www.dropbox.com/oauth2/authorize?client_id=<APP_KEY>&response_type=code&token_access_type=offline`,
   approve, copy the `code`, then exchange it:
   ```
   curl https://api.dropboxapi.com/oauth2/token \
     -d code=<CODE> -d grant_type=authorization_code \
     -u <APP_KEY>:<APP_SECRET>
   ```
   The JSON's `refresh_token` is the durable value.

```
npm run secret:sux DROPBOX_APP_KEY
npm run secret:sux DROPBOX_APP_SECRET
npm run secret:sux DROPBOX_REFRESH_TOKEN
```

> Full-Dropbox (Mode B, not yet built) would use a **separate** Full-Dropbox app +
> `DROPBOX_FULL_REFRESH_TOKEN`, kept distinct so scope stays the wall.

---

## 3. Todoist — `TODOIST_TOKEN` (tasks)

**Where:** [todoist.com/app/settings/integrations/developer](https://todoist.com/app/settings/integrations/developer)
→ copy the **API token**.

**Read vs write:** Todoist's personal API token is **full access** (read + write) — there
is no read-only variant. One value, done.

```
npm run secret:sux TODOIST_TOKEN
```

---

## 4. Gmail — `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET` + `GMAIL_REFRESH_TOKEN`

**Where:** [console.cloud.google.com](https://console.cloud.google.com).

**Steps:**
1. **New project** → **APIs & Services → Library → enable "Gmail API"**.
2. **OAuth consent screen** → **External** → add yourself under **Test users**.
3. **Credentials → Create credentials → OAuth client ID → Desktop app** → copy the
   **client id** + **client secret**.
4. Do the one-time consent for a **refresh token** with the scope you want:
   - **Read-only:** `https://www.googleapis.com/auth/gmail.readonly`.
   - **Read + modify (no send):** `https://www.googleapis.com/auth/gmail.modify`.
   - **Read/write incl. send:** `https://mail.google.com/` (full) — or `gmail.modify`
     + `https://www.googleapis.com/auth/gmail.send`.

```
npm run secret:sux GMAIL_CLIENT_ID
npm run secret:sux GMAIL_CLIENT_SECRET
npm run secret:sux GMAIL_REFRESH_TOKEN
```

---

## 5. Obsidian — `OBSIDIAN_REST_TOKEN` (live-vault REST)

**Where:** the **Obsidian desktop app** (not a website) → **Settings → Community plugins
→ Local REST API → API Key** (install the "Local REST API" plugin first if absent).

**Read vs write:** the key is **full read/write** over the vault (there's no read-only
mode). This is for the *live* vault path (the future headless container); the git-backed
`/vault/mcp` you use today needs no key.

```
npm run secret:sux OBSIDIAN_REST_TOKEN
```

> Cannot be generated via a browser — it's created inside the desktop app.

---

## 6. Health — `APPLE_HEALTH_TOKEN` and/or `EPIC_FHIR_CLIENT_ID`

Two independent sources; both are **read-only** by nature.

- **Apple Health** (`APPLE_HEALTH_TOKEN`): the **Health Auto Export** iOS app (Premium)
  → add a **REST API automation** → *you choose* the bearer token (a shared secret you
  invent), and it POSTs your vitals to sux's `/apple-health` route. Set the same value:
  ```
  npm run secret:sux APPLE_HEALTH_TOKEN
  ```
  Generated on the **phone**, not a browser.
- **Epic / MyChart** (`EPIC_FHIR_CLIENT_ID`): register a **patient-facing app** at
  [fhir.epic.com](https://fhir.epic.com) → get a **client id** → SMART-on-FHIR OAuth with
  **read-only USCDI** scopes (patient FHIR access is read-only). Per-health-system client
  secret as needed.
  ```
  npm run secret:sux EPIC_FHIR_CLIENT_ID
  ```

---

## 7. Facebook — `FACEBOOK_TOKEN`

**Where:** [developers.facebook.com](https://developers.facebook.com) → **My Apps →
Create App** (type: *Other / None*).

**Steps:** open **Tools → Graph API Explorer**, select your app, grant read scopes
(`public_profile`, `user_posts`, `user_photos` — all **read**), **Generate Access Token**,
then optionally exchange it for a **long-lived** token (60 days) at the token debugger.
The Graph API surface here is **read-only**; write/publish scopes need Facebook app review
and aren't used by sux.

```
npm run secret:sux FACEBOOK_TOKEN
```

---

## 8. Reddit — `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`

**Where:** [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) → **create another
app…**.

**Steps:** type **script**; name `sux`; redirect uri `http://localhost` (unused). Create.
The **client id** is the string under the app name ("personal use script"); the **secret**
is the `secret` field. sux uses app-only OAuth (`client_credentials`) — **read-only**.

```
npm run secret:sux REDDIT_CLIENT_ID
npm run secret:sux REDDIT_CLIENT_SECRET
```

---

## 9. eBay — `EBAY_CLIENT_ID` + `EBAY_CLIENT_SECRET`

**Where:** [developer.ebay.com](https://developer.ebay.com) → register (developer account)
→ **My Account → Application Keys**.

**Steps:** create a **Production** keyset → copy **App ID (Client ID)** and **Cert ID
(Client Secret)**. sux's Browse API uses the application (client-credentials) token —
**read-only** marketplace search.

```
npm run secret:sux EBAY_CLIENT_ID
npm run secret:sux EBAY_CLIENT_SECRET
```

---

## Quick reference

| Service | Secret(s) | Read-only? | Browser-generatable |
|---|---|---|---|
| Fastmail | `FASTMAIL_TOKEN` | yes (pick at creation) | ✅ |
| Dropbox | `DROPBOX_REFRESH_TOKEN` + `_APP_KEY` + `_APP_SECRET` | yes (permissions tab) | ✅ (+ 1 curl) |
| Todoist | `TODOIST_TOKEN` | no (full only) | ✅ |
| Gmail | `GMAIL_CLIENT_ID` + `_SECRET` + `_REFRESH_TOKEN` | yes (scope choice) | ✅ (+ mint) |
| Obsidian | `OBSIDIAN_REST_TOKEN` | no (full) | ❌ desktop app |
| Health | `APPLE_HEALTH_TOKEN` / `EPIC_FHIR_CLIENT_ID` | read-only | phone / ✅ |
| Facebook | `FACEBOOK_TOKEN` | read-only | ✅ |
| Reddit | `REDDIT_CLIENT_ID` + `_SECRET` | read-only | ✅ |
| eBay | `EBAY_CLIENT_ID` + `_SECRET` | read-only | ✅ |
