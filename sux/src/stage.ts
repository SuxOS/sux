import { type RtEnv } from "./registry";

// Stage-then-commit — the accidental-misuse guard for every side-effectful verb. A caller
// passes stage:true to get back { preview, commit_token } WITHOUT mutating; a second call
// passing that token commits, iff the token is unspent, unexpired (5-min TTL), and the exact
// payload still hashes to what was staged. The token binds to the payload so a stale preview
// can't commit a changed action. This is a two-STEP guard (mint then spend are separate tool
// calls), NOT an injection boundary — a read-only credential is the real containment.

const PREFIX = "sux:stage:";
const TTL_SECONDS = 300;

// In-isolate spent-token claim. A commit's KV get→verify→delete is not atomic —
// KV has no compare-and-set — so two concurrent commits of ONE token could both
// read it present, both delete, and both run mutate(): a double-spend (for
// mail_send, a user-visible double-send). This synchronous Set is the single-
// winner guard for the common case: JS in a Worker isolate is single-threaded, so
// the has→add below runs with NO await between the check and the claim, making it
// impossible for two concurrent commits IN THIS ISOLATE to both win. The KV delete
// still fires so other isolates (and later retries) see the token spent — that
// cross-isolate leg stays best-effort (a Durable Object is the only true multi-
// isolate CAS; deferred until send volume makes a rare cross-isolate race matter).
// Bounded so a long-lived isolate can't leak: tokens are one-shot and 5-min TTL'd,
// so a full clear past the cap only reopens the (already best-effort) cross-window.
const spentTokens = new Set<string>();
const SPENT_CAP = 10_000;

function claimToken(token: string): boolean {
	if (spentTokens.has(token)) return false;
	if (spentTokens.size >= SPENT_CAP) spentTokens.clear();
	spentTokens.add(token);
	return true;
}

async function hashPayload(payload: unknown): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload ?? null)));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randToken(): string {
	const a = new Uint8Array(18);
	crypto.getRandomValues(a);
	return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type StageResult = { staged: true; kind: string; preview: unknown; commit_token: string; expires_in: number; note: string };

/** Mint a commit token bound to `payload` and return the preview. Performs NO mutation. */
export async function stage(env: RtEnv, kind: string, payload: unknown, preview: unknown): Promise<StageResult> {
	const token = randToken();
	const hash = await hashPayload(payload);
	await env.OAUTH_KV?.put(`${PREFIX}${token}`, JSON.stringify({ kind, hash }), { expirationTtl: TTL_SECONDS });
	return { staged: true, kind, preview, commit_token: token, expires_in: TTL_SECONDS, note: `Nothing done yet. Re-call the same verb with commit_token:'${token}' (+ the identical payload) within 5 min to commit.` };
}

/** Verify + consume a commit token against `payload`. Throws a clear reason on any mismatch; single-use. */
export async function commit(env: RtEnv, kind: string, token: string, payload: unknown): Promise<void> {
	const raw = await env.OAUTH_KV?.get(`${PREFIX}${token}`);
	if (!raw) throw new Error("commit_token is invalid, already spent, or expired (5-min TTL) — re-stage to get a fresh preview.");
	let rec: { kind?: string; hash?: string };
	try {
		rec = JSON.parse(raw);
	} catch {
		rec = {};
	}
	if (rec.kind !== kind) throw new Error(`commit_token was staged for '${rec.kind}', not '${kind}'.`);
	if (rec.hash !== (await hashPayload(payload))) throw new Error("the payload changed since staging — the commit_token is bound to the exact previewed action. Re-stage.");
	// Single-winner claim: the synchronous has→add makes a concurrent second commit
	// of this token in the same isolate lose here (see spentTokens) rather than
	// racing to a double mutate(). Must precede the KV delete so the claim is the
	// authority — a lost claimant never reaches mutate() in staged().
	if (!claimToken(token)) throw new Error("commit_token is already being spent by a concurrent commit — single-use.");
	await env.OAUTH_KV?.delete(`${PREFIX}${token}`).catch(() => {});
}

/**
 * The stage/commit dispatch every side-effectful verb wraps its mutation in:
 *   - force:true          → runs `mutate()` directly, bypassing the guard entirely
 *                           (the `!`-override: an explicit opt-out that wins over
 *                           stage/commit_token — for callers that never want a gate)
 *   - stage:true          → returns the preview + a commit_token (no mutation)
 *   - commit_token present → verifies+consumes it, then runs `mutate()`
 *   - neither             → runs `mutate()` directly (unguarded, the caller opted out)
 * Returns the StageResult only in the stage case; else the mutate result. With
 * `force` absent/false the dispatch is byte-identical to the pre-force behavior.
 */
export async function staged<T>(env: RtEnv, kind: string, args: { stage?: boolean; commit_token?: string; force?: boolean }, payload: unknown, preview: unknown, mutate: () => Promise<T>): Promise<{ stageResult: StageResult } | { result: T }> {
	// `force` is the generalized `!`-override: opt out of staging outright, ahead of
	// any stage/commit_token, so a caller that has decided can't be forced into a
	// round-trip. It never mints or consumes a token.
	if (args?.force === true) {
		return { result: await mutate() };
	}
	if (args?.commit_token) {
		await commit(env, kind, String(args.commit_token), payload);
		return { result: await mutate() };
	}
	if (args?.stage === true) {
		return { stageResult: await stage(env, kind, payload, preview) };
	}
	return { result: await mutate() };
}
