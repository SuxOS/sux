---
title: SuxOS v10 L3 — harden, correct, make mergeable
status: draft (pending owner review) — rev 2, post adversarial verification
type: design
arc: v10 (L3 hardening — follows the Retrieval Plane spec)
owner: m@colinxs.com
updated: 2026-07-16
summary: "Turn the live-but-unsafe sux-compute L3 skeleton into something safe to run, honest about its limits, and mergeable without wedging the repo — merge-safety + CI (A), a fail-closed access model (B), and a rootless-dind re-image (C). Egress cutover (D) and the L0 job substrate are explicitly out of scope."
---

# SuxOS v10 L3 — harden, correct, make mergeable

## 1. Why this exists

The v10 L3 walking skeleton (`compute/` — the `sux-compute` Worker + dind box + Workers-VPC
proof) shipped live the same day it was designed. A four-dimension audit (2026-07-16) plus
four platform-reality research runs found it simultaneously **live, internet-exposed,
un-type-checkable, and un-mergeable** — because it is a second wrangler project inside an
auto-deploy repo with no CI, so a green `wrangler deploy` never had to prove auth, types, or
merge-safety. The unauthenticated public bridge into the home LAN was already closed with a
reversible stopgap; this spec is the durable correction.

This is a **hardening + correction** arc, not a feature arc. It builds nothing on the
Retrieval Plane's F1–F15 roadmap. It makes the ground under L3 solid.

**Rev 2 note.** Rev 1 was adversarially verified by three independent passes and failed:
Part B's guard was undecidable and **failed open**, and Part C rested on a platform behaviour
disproved against the pinned library. Those are corrected here. The corrections are recorded
rather than quietly patched, because "a decision asserted with no mechanism behind it" is the
exact failure the audit flagged in the predecessor spec.

## 2. Scope and landing order

**In scope — three parts:**

- **A — Merge-safety + CI.** Stop `compute/` from wedging the repo's type-check/deploy, and
  give it its own gates so it is no longer an out-of-band manual deploy.
- **B — Fail-closed access model.** Make the Worker reachable only by its intended caller,
  structurally.
- **C — Rootless dind experiment.** Re-image onto the only vendor-supported dind path, fix
  the correctness/observability defects, and label it honestly.

**Landing order is NOT free (D0).** `compute/` does not exist on `origin/main`
(`git ls-tree origin/main -- compute` is empty) and `origin/main`'s root tsconfig still
excludes only `research-tools`. The moment `compute/` reaches `main` without A1, the required
"Type-check & build" gate goes red for **every open PR** in the repo. Therefore:

> **A1 must ship in the same PR that first brings `compute/` to `main`.** B and C both edit
> files under `compute/`, so neither can land before that. Order: **A1 (+`compute/`) → {B, C}**.

They are *not* "independently landable"; A1 is a hard prerequisite.

**Explicitly out of scope (named, not forgotten):** see §10.

**Carried-forward architecture decisions (owner-directed 2026-07-16):** keep the full
Cloudflare edge stack — Workers + Workers VPC + Containers (Containers demoted to the
experiment of Part C); AI Search is in the v10 scope (later burst); persistent/privileged
Docker (D11) runs on the home router / OpenWRT node now, splitting to a dedicated box later.

## 3. Part A — Merge-safety + CI

### A1 — Un-wedge the root type-check (clears audit BLOCKER-1)
The root `tsconfig.json` has no `include` and excludes only `research-tools`, so it compiles
`compute/src/index.ts` against `@cloudflare/containers` — a dep the root never installs —
failing `npm run type-check` (`TS2307`), the first required gate in both `ci.yml` and
`deploy.yml`.

**Decision A1:** set root `tsconfig.json` `exclude: ["research-tools", "compute"]`. The
mechanism is the exclude glob keeping a sibling project out of the root program — note the
cited `research-tools/` directory **no longer exists** (only the stale exclude + comment
survive), so cite the mechanism, not the precedent; optionally drop the dead entry. `gen:index`
(scans `sux/src/fns`) and the dry-run (scoped to `sux/wrangler.jsonc`) are unaffected — verified.

### A2 — Make `compute/` type-check on its own
`compute/tsconfig.json` declares `@cloudflare/workers-types` in `types` but the package has no
install entry in `compute/package-lock.json` (it appears only as wrangler's *optional
peerDependency*), so a clean `npm ci` doesn't install it → `TS2688` (reproduced on the
committed tree). It also omits `skipLibCheck`, so `@cloudflare/containers`' own `.d.ts`
clashes with workers-types → `TS2416`. The `index.ts` source is clean; the config is not.

**Decision A2:** in `compute/`: add `@cloudflare/workers-types` to `devDependencies` **and
regenerate + commit `compute/package-lock.json`** (`npm ci` hard-fails when `package.json` and
the lock disagree — omitting this breaks A2's own acceptance command); set
`"skipLibCheck": true` in `compute/tsconfig.json`; add `"type-check": "tsc --noEmit"` to
scripts. Acceptance: `npm --prefix compute ci && npm --prefix compute run type-check` exits 0.

### A3 — CI for `compute/` (advisory by design)
**Decision A3:** a dedicated workflow `.github/workflows/compute-ci.yml`, triggered on
`pull_request`/`push` with `paths: ["compute/**"]`, running `npm ci` + `npm run type-check` in
`compute/`. It is **deliberately NOT added to `main`'s required-check set**: this org has a
documented jam where a path-filtered workflow that is *also* required blocks every PR that
doesn't touch those paths (no check-run ever reports). Do not "fix" this by making it required.
It is therefore **advisory** — which is why A4 carries the real gate.

### A4 — Deploy `compute/` through the pipeline, and gate it there
The live `sux-compute` worker was shipped by a manual `wrangler deploy`; the pipeline can
neither redeploy nor roll it back. And since A1 removes `compute/` from the required gate and
A3 is advisory, **nothing blocks a red `compute/` from reaching `main`** — so the gate must
live at the deploy, mirroring `deploy.yml`'s own precedent (it re-runs type-check/test/blob-sync
before `wrangler deploy`).

**Decision A4:** `.github/workflows/compute-deploy.yml`, trigger `workflow_dispatch` (manual,
gated) initially; it runs `npm ci && npm run type-check` in `compute/` as a **blocking step**
before `wrangler deploy`. Auto-deploy on push-to-`main` under `paths: compute/**` graduates in
once A1–A3 are green for one cycle.

**Decision A4a (credentials — verify before building):** `deploy.yml`'s token is documented as
"Edit Cloudflare Workers" / `Account → Workers Scripts → Edit`. A **Containers** deploy also
**builds and pushes an image** to Cloudflare's managed registry, which needs more than
Workers-Scripts:Edit. The live worker was deployed by hand from the Mac (full creds + local
Docker), so it proves nothing about the CI token. **Before implementing A4:** verify the
token's real scope, state the required permissions, and mint + name a new secret if
insufficient. Also: `deploy.yml`'s job declares `environment: production`; if the token is an
*environment* secret, `compute-deploy.yml` must declare the same environment or the secret
resolves empty and fails with a confusing auth error. `compute-deploy.yml` **declares
`environment: production`**.

**Decision A4b (rollback):** rollback = **dispatch `compute-deploy.yml` at the previous green
SHA**, with the image rebuilt from the digest-pinned base (C5). This is only a true rollback
because the base is digest-pinned; without C5 it is a rebuild, not a restore. `wrangler
rollback` semantics for a Containers-backed Worker are **not** relied upon (unverified for
Containers). Until A4 lands, `compute/README.md` records the live worker as unmanaged.

## 4. Part B — Fail-closed access model

The stopgap removed the public `workers.dev` URL (`workers_dev:false` + `preview_urls:false`,
committed). Part B makes that posture **structural and decided**, rather than a runtime guess.

### B1 — Keep the public front door shut
**Decision B1:** `workers_dev:false` + `preview_urls:false` stay, config-pinned (dashboard-only
disabling reverts on the next Wrangler deploy — Cloudflare's own documented warning). **No
`route` and no custom domain are added by this spec.** With no route, there is no anonymous
public HTTP ingress at all.

### B2 — The only caller path: a Service Binding to a named entrypoint
**Decision B2:** internal callers reach `sux-compute` through a **Service Binding to a named
entrypoint** — `services: [{ binding: "COMPUTE", service: "sux-compute", entrypoint: "Internal" }]`
in the caller's `wrangler.jsonc`, invoked as `env.COMPUTE.fetch(...)`. `sux-compute` exports
`class Internal extends WorkerEntrypoint` carrying the internal surface (`/box/:name`, `/vpc`).
Named entrypoints are reachable **only** through a declared binding, never via an HTTP route.
Requests never traverse a public URL; no per-request secret is needed on this hop.

**Decision B2a (caller-side typegen):** `sux/wrangler.jsonc` has no `services` block today, and
the root tsconfig's only `types` entry is the **committed** `worker-configuration.d.ts`. Adding
the binding requires re-running `npm run cf-typegen` and **committing the regenerated
`worker-configuration.d.ts`** — otherwise `env.COMPUTE` doesn't exist and the *required* gate
goes red with "Property 'COMPUTE' does not exist". No CI drift gate covers typegen, so this is
a manual step in the same PR.

**Trust boundary, stated honestly:** a service binding is declared *unilaterally by the caller*
— the callee grants nothing — so the real boundary is "any Worker deployable to this Cloudflare
account," not "the `sux` Worker specifically." Accepted for a single-owner account; recorded,
not hidden.

### B3 — The default export is fail-closed
Rev 1's guard ("if the request arrived via the service binding, allow; else require a JWT")
was **undecidable and failed open**: Workers exposes no documented marker distinguishing a
binding invocation from any other request into the default `fetch()`, and the only implicit
discriminator — *no JWT ⇒ must be internal ⇒ allow* — admits exactly the anonymous attacker the
guard exists to stop. Trust that must be *inferred* is trust that can be *forged*.

**Decision B3:** the **default export's `fetch()` returns `403` unconditionally** and does no
routing, no container start, and no VPC reach. It exists only as a fail-closed floor should a
route ever be attached by accident. All real surface lives on the `Internal` entrypoint (B2).
There is no runtime classification to get wrong.

**Decision B3a:** operator/human HTTP access is **not built** (see §10 — it has a trigger and a
worked recipe). Operator debugging already has an authenticated path that does not touch this
Worker's ingress: `wrangler containers ssh` / `wrangler containers instances`, which
authenticate against the Cloudflare account. This is why no Access application, route, AUD tag,
or JWT-validation code is in scope: nothing needs them yet, and building them now would add an
Access-app bootstrap seam (the AUD tag only exists *after* the app is created) for no caller.

## 5. Part C — Rootless dind experiment

Platform-reality research: **privileged `docker:dind` is unsupported on Cloudflare Containers**
(non-root, no `--privileged`); the only vendor path is `docker:dind-rootless`, which itself
needs a flag absent from Cloudflare's docs; **all disk is ephemeral** (a slept box wakes blank);
and cloudflare/sandbox-sdk#662 is **still open** — a Cloudflare engineer's last word (2026-06-22)
is that *the Sandbox SDK cannot currently work around it* and that he may **remove the
Docker-in-Docker docs**. (Precisely: he did not call dind itself unworkable; he said the SDK
can't work around the breakage and floated pulling the docs.) Owner decision: keep the box as
an **at-risk experiment**, not the production compute plane.

### C1 — Re-image to rootless, as the vendor actually does it
**Decision C1:** `FROM docker:dind-rootless` **followed immediately by `USER root`** — this is
Cloudflare's own working recipe and it is load-bearing. Without `USER root` you inherit the
image's default `USER rootless` (uid 1000) and `DOCKER_HOST=unix:///run/user/1000/docker.sock`;
dockerd then runs under rootlesskit, the socket moves, and every dockerd probe that assumes
`/var/run/docker.sock` breaks on a healthy box. `USER root` means *root-in-a-user-namespace*,
not host root — the Container's non-root platform constraint still holds.

dockerd flags: `--iptables=false --ip6tables=false` (vendor guide, verbatim) plus
`--exec-opt native.cgroupdriver=cgroupfs` — **absent from Cloudflare's docs** but the confirmed
production fix in #662, without which inner `docker run` fails on a cgroup/systemd shim error.
Inner commands run with `--network=host`. Nothing else is required: **no fuse-overlayfs, no
explicit storage driver, no rootlesskit flags**. Accept ephemeral state and at-risk vendor
status.

### C2 — PID-1 reaping
**Decision C2:** `apk add --no-cache tini` (Alpine `docker:dind*` does **not** ship it), then
`ENTRYPOINT ["tini","--","/usr/local/bin/start.sh"]`. `start.sh` backgrounds dockerd in a
subshell (so it reparents to PID 1) and `exec`s the status server, making tini PID 1 and the
reaper of every orphan including dockerd's escaped descendants. Running dockerd as PID 1 would
be **worse** — dockerd is not an init and the status server would lose the foreground.

### C3 — An honest `/health` (scoped to what it can actually do)
Rev 1 claimed "the Container port check uses this." **That is false**, disproved against the
pinned `@cloudflare/containers` v0.2.4 source: readiness is a TCP/`fetch` probe to
`http://ping/` — **path `/`, never `/health`** — whose response is **discarded**, breaking on
any non-throwing fetch. **A 503 counts as ready.** `server.py` binds 8080 before dockerd exists,
so the box is marked ready with dockerd down regardless of `/health`. (Silver lining: C3
therefore carries **no boot-loop risk**.)

**Decision C3:** `/health` returns `503` when dockerd is down and `200` when up, and is
meaningful **only to callers that explicitly probe it** — the Worker's `/box/:name/health`
(reachable only after C5), a monitor, or the spine. It does **not** gate platform routing. If
dockerd death must actually gate traffic, that requires the *port* to fail (status server exits
when dockerd dies) or the Worker to probe `/health` itself after `startAndWaitForPorts()` —
both **out of scope** (§10).

**Decision C3a (resolve the socket, don't hardcode):** `server.py` resolves the daemon via
`DOCKER_HOST` with a `/var/run/docker.sock` fallback rather than hardcoding either path, so it
is correct under both `USER root` (C1) and any future true-rootless variant.

**Decision C3b (boot grace window):** `docker version` immediately after cold start legitimately
fails before the daemon is ready (#662). `/health` reports `starting` (`503` with a distinct
body) during a bounded grace window and only reports `dead` after it, mirroring the vendor's
`until docker version` poll. A booting box must not read as broken.

**Decision C3c (cheap `/`):** the readiness probe hits `/`, which today shells out to
`docker version` **and** `docker ps` (5s timeouts each) on **every ping**. `/` becomes a cheap
static handler that does not shell out; the expensive status moves to `/status`.

### C4 — Upstream error handling
**Decision C4:** both `getContainer(...).fetch(request)` and `env.MAC_VPC.fetch(...)` are
wrapped in try/catch returning structured `502` JSON. The VPC call gets
`AbortSignal.timeout(5000)` (**5s** — the one number that decides how fast a dropped connector
fails; consistent with the box fetch) and a byte-capped body read, replacing the current
buffer-then-slice (`(await upstream.text()).slice(0, 500)`). The VPC research confirms a dropped
connector makes `fetch()` **throw** ("Bad Upstream"), so this path must fail cleanly.
`getContainer().fetch()` also throws on **start timeout** — the 502 must distinguish "still
booting" from "broken" (ties to C3b), not mask it.

### C5 — Honest framing, real routing fix, image hygiene
**Decision C5:** the false framing is *committed in two files* and must be corrected there, not
just in prose: `compute/package.json`'s description says "dind **pet boxes**" and
`compute/wrangler.jsonc`'s comment says "a **privileged** dind plane" — both false after C1
(rootless) and after ephemeral-disk reality. **Create** `compute/README.md` (it does not exist)
stating: rootless, at-risk experiment; not the production compute plane; no v10 feature depends
on it; persistent/privileged Docker lives on the home router (D11); and **this box cannot be
exercised under local `wrangler dev`** (per #662 that needs an unsupported socket-proxy hack
injecting `HostConfig.Privileged=true`).

**Decision C5a (routing — the regex is fine):** the sub-path bug is **forwarding**, not the
regex. `^\/box\/([a-z0-9-]{1,32})(\/.*)?$` already captures the sub-path in group 2; the code
forwards the unmodified `request`, so the box receives `/box/:name/health` and `server.py`'s
`if self.path == "/health"` never matches (verified by execution). Fix = rewrite the URL to
group 2 (`box[2] ?? "/"`) before forwarding. **C3 is untestable through the Worker until this
lands — sequence C5a before/with C3.** Separately, `/box/FOO/…` and `/box/foo_bar/…` currently
fall through to the manifest with `200`; they return **`404`** deliberately.

**Decision C5b (image hygiene):** pin the base image to a digest. Drop `git` and
`openssh-client` (nothing uses them — `wrangler containers ssh` uses the platform's SSH plus
`authorized_keys` in `wrangler.jsonc`, not the image's client). **Keep `curl`** — it is the
cheapest honest dockerd liveness check (`curl --unix-socket … /_ping`) for C3.

## 6. Security posture (after this spec)

- The Worker has **no public HTTP ingress** (B1: no route, workers.dev off) and its only real
  surface is a named entrypoint reachable solely via a declared Service Binding (B2); the
  default export is fail-closed `403` (B3). The audit's CRITICAL and its H1/H2 (public `/vpc`
  bridge, unauthenticated box-boot DoS) are **closed**, not merely mitigated — **modulo** the
  account-level trust boundary stated in B2 (any Worker deployable to this account can declare
  the binding), which is accepted for a single-owner account.
- The `sux-home` tunnel is inbound-safe by construction (cloudflared dials outbound-only).
- The box runs root-in-userns inside a per-instance CF micro-VM (C1); the VM boundary plus the
  rootless image replace the privileged-box risk. No secrets are committed (only an SSH public
  key + resource UUIDs); `.gitignore` covers `node_modules/`/`.wrangler/`.

## 7. Testing & observability

- **CI (A2/A3):** `npm --prefix compute ci && npm --prefix compute run type-check` exits 0 and
  runs advisory on every `compute/**` change; the same command **blocks** `compute-deploy.yml`.
- **Access (B):** a test asserts the default export returns `403` for any request (B3), and that
  the `Internal` entrypoint serves `/box`/`/vpc` when invoked through a binding. A regression
  test asserts no public route resolves (the class the stopgap closed).
- **Box (C):** `/health` reports `starting` during the grace window, `200` with dockerd up, and
  `503` after it dies (C3/C3b); `/box/:name/health` actually reaches the box's `/health` (C5a);
  `/box/FOO/` returns `404`; `/` does not shell out (C3c).
- **dind (C1) — conditional, see §9:** rootless `docker run --network=host hello-world` inside
  the box.

## 8. Decision table

| # | Decision |
|---|---|
| D0 | **A1 ships in the same PR that first brings `compute/` to `main`**; order A1 → {B, C}. Not independently landable. |
| A1 | Root `tsconfig.json` excludes `compute` (the mechanism is the glob; the `research-tools` precedent is a dead directory). |
| A2 | `compute/` adds `workers-types` **+ regenerated committed lockfile** + `skipLibCheck:true` + a `type-check` script. |
| A3 | `compute-ci.yml` on `paths: compute/**`, **advisory — deliberately NOT required** (path-filtered + required = the known repo-wide jam). |
| A4 | `compute-deploy.yml` (`workflow_dispatch` first) runs type-check as a **blocking** step before deploy — the real gate. |
| A4a | Verify the CI token's scope before building: Containers deploys build+push an image, exceeding Workers-Scripts:Edit. Declares `environment: production`. |
| A4b | Rollback = dispatch at the previous green SHA (true restore only because C5b digest-pins the base). `wrangler rollback` for Containers is not relied on. |
| B1 | `workers_dev:false` + `preview_urls:false`, config-pinned. **No route, no custom domain.** |
| B2 | Sole caller path = Service Binding to a named `Internal` entrypoint (unreachable via HTTP). Trust boundary = anyone who can deploy to this account (stated, accepted). |
| B2a | Adding the binding requires `npm run cf-typegen` + committing `worker-configuration.d.ts`, or the required gate goes red. |
| B3 | Default export `fetch()` = **unconditional `403`**. No runtime "did this come via the binding" classification — that test is undecidable and fails open. |
| B3a | Operator HTTP **not built**; `wrangler containers ssh` already provides an account-authenticated path. Access+JWT recipe parked in §10 with a trigger. |
| C1 | `FROM docker:dind-rootless` **+ `USER root`** (load-bearing: otherwise the socket moves); `--iptables=false --ip6tables=false --exec-opt native.cgroupdriver=cgroupfs`; inner `--network=host`. |
| C2 | `apk add tini`; `tini` as PID 1 reaps dockerd's orphans. dockerd-as-PID-1 rejected. |
| C3 | `/health` is honest but **advisory** — the platform's readiness probe hits `/` and discards the response (a 503 counts as ready). It does not gate routing. |
| C3a/b/c | Resolve `DOCKER_HOST` (don't hardcode); a boot grace window (`starting` ≠ `dead`); a cheap `/` that doesn't shell out per ping. |
| C4 | try/catch → 502, `AbortSignal.timeout(5000)`, byte-capped read; distinguish "still booting" from "broken". |
| C5 | Fix the framing **in `package.json` + `wrangler.jsonc`**, create `README.md`; box cannot run under local `wrangler dev`. |
| C5a | Routing fix is a **URL rewrite** (`box[2] ?? "/"`), not a regex change; `/box/FOO/` → `404`. Sequence before/with C3. |
| C5b | Digest-pin the base; drop `git`/`openssh-client`; **keep `curl`** (dockerd `/_ping`). |
| D-egress (deferred) | VPC + Tailscale run **in parallel**; retire Tailscale only after the beta VPC path proves under real load — **not** the 7-day probe gate (amends Retrieval-Plane D2). Built in a later unit. |

## 9. Definition of done

- **A:** `npm run type-check` is green on a branch containing `compute/` (A1); `npm --prefix
  compute ci && npm --prefix compute run type-check` exits 0 (A2); `compute-ci.yml` runs
  **advisory** on `compute/**` (A3) and the same check **blocks** `compute-deploy.yml` (A4);
  the worker is deployable, and rollback-able per A4b, via that workflow. A1 landed in the same
  PR as `compute/` (D0).
- **B:** the default export returns `403` for every request (B3); `sux` reaches the box through
  the `COMPUTE` service binding to the `Internal` entrypoint with regenerated committed types
  (B2/B2a); no public route resolves.
- **C:** the box boots on `docker:dind-rootless` + `USER root` with tini as PID 1; `/` is cheap;
  `/box/:name/health` reaches the box and reports `starting`/`200`/`503` correctly (C3/C5a);
  `compute/README.md`, `package.json`, and `wrangler.jsonc` carry the honest framing (C5).
- **C — conditional dind gate (D-C-gate):** *either* rootless `docker run --network=host
  hello-world` succeeds inside the box, *or* the failure is recorded against
  cloudflare/sandbox-sdk#662 and the box is **parked** (kept deployed, marked non-functional in
  `README.md`) — this is deliberately **not** an unconditional pass/fail, because that exact
  operation is what #662 shows failing in production while a Cloudflare engineer weighs deleting
  the DinD docs. **Abandon criterion:** if #662 resolves as "unsupported" or the DinD docs are
  removed, retire the box entirely and move all Docker to the home router (D11).

## 10. Out of scope / next

- **Operator HTTP access (parked, with trigger).** Trigger: the first time a caller genuinely
  needs HTTP into `sux-compute`. Recipe when it lands: a **custom route** (workers.dev stays
  off) behind a **Cloudflare Access** application, with the Worker validating the
  `Cf-Access-Jwt-Assertion` header (never the `CF_Authorization` cookie — not guaranteed to be
  passed) via **`jose`'s `createRemoteJWKSet` + `jwtVerify`**, as Cloudflare's own Workers
  example does — hand-rolling is forbidden: `jose` does `kid`, signature, `iss`, `aud`, **`exp`
  and `nbf`** in one call, cannot be alg-confused (the JWKS yields an RSA public key, so
  `alg:none`/HS256 won't verify), and handles JWKS caching + rotation. `issuer` =
  `https://<team>.cloudflareaccess.com` — **the full URL with scheme**; a bare hostname rejects
  every token. Add an operator `email` allowlist (validating `iss`/`aud`/signature proves Access
  authenticated *someone*, not *who*). If an automated caller ever uses it, its Access policy
  action must be **Service Auth** (`decision: non_identity`) — service-token JWTs carry
  `sub: ""` + `common_name`, which the email allowlist must special-case.
- **dockerd death gating traffic** — requires the port to fail or a Worker-side probe after
  `startAndWaitForPorts()`; C3 is advisory only.
- **D — Egress cutover** (next hardening unit): `proxy.ts` transport swap, `_vpc_selftest`,
  spine `transport` label, and the parallel-run → load-proven → retire-Tailscale sequence.
- **L0 (F7/F8)** — resolve the queue→Workflow idempotency contract (audit BLOCKER-2) before the
  async `research` substrate is built.
- **L2 AI Search (F13/F14)** — the corpus layer; greenlit, later burst. Note: AutoRAG generation
  bills via AI Gateway, not the sux request-gate governor — cap spend in the Gateway (audit M3).
