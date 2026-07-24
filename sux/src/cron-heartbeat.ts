import { recordAnalyticsEvent } from "./analytics";
import { type RtEnv } from "./registry";

// Per-subsystem heartbeats for the daily cron. After each unattended sub-job
// (Kroger refresh, mail triage, adblock rebuild, self-improve) we stamp
// {ok,at,error?} into KV so gatherHealth can surface last-success + staleness on
// the public status page. Without this a failure lands only in `wrangler tail`
// (console.warn ships nowhere), where a silently-stalled autonomous loop — mail
// triage, self-improve — can go unnoticed for weeks. Observability only: it never
// changes a sub-job's behavior, and a KV write failure must never turn a working
// tick into a thrown error.

const PREFIX = "sux:cron:heartbeat:";

// The daily cron fires once every 24h, so a heartbeat older than ~26h (a day plus
// jitter/retry slack) means the sub-job stopped running — flagged as `stale`.
export const CRON_STALE_MS = 26 * 60 * 60 * 1000;

// Every named sub-job the daily cron runs, in tick order. gatherHealth reports one
// entry per name; a name that has never fired reports { seen: false }.
export const CRON_JOBS = ["kroger_token", "mychart_token", "mychart_pull", "mail_triage", "mail_triage_plan", "vault_consolidate_plan", "contact_consolidate_plan", "files_consolidate_plan", "mychart_reconcile_plan", "vault_cross_link_plan", "ask_gate_reminder", "agenda_reply", "agenda_ask", "imessage_reply", "vectorize_backfill", "weekly_recall", "consolidate", "watch_sweep", "cross_semantic", "briefing", "agenda", "adblock", "life_wiki", "infer_nudge", "self_improve", "web_search_selftest", "learning_folder", "gh_actions_billing", "dropbox_ingest"] as const;
export type CronJob = (typeof CRON_JOBS)[number];

export type Heartbeat = { ok: boolean; at: number; error?: string };

/** Coerce any thrown or reported error value into a NON-EMPTY string (#1480).
 *
 * Every caller here has the same requirement — a red heartbeat must carry text a human can
 * act on — and every caller previously got it slightly wrong in a different way. The two
 * live holes this closes:
 *   • `String((e as Error)?.message ?? e)` yields "" for `new Error("")`, because "" is not
 *     nullish so `??` never falls through to `e`. recordHeartbeat's `if (error)` then drops
 *     it, producing the ok=false-with-no-error beat observed in prod for mail_triage.
 *   • A report carrying `error` as an Error/object (not a string) fell through the old
 *     string-only check and was recorded as ok=TRUE — a failure logged as a success.
 * Falsy inputs are the caller's business (they mean "no error"); this only runs once the
 * caller has decided an error exists, so an empty result here is always a bug to name, not
 * a state to pass through. */
function errorText(value: unknown, fallback: string): string {
	if (typeof value === "string" && value.length > 0) return value;
	if (value instanceof Error) {
		if (typeof value.message === "string" && value.message.length > 0) return value.message;
		// An Error with no message still tells us its constructor — strictly better than nothing.
		return value.name ? `${value.name} (no message)` : fallback;
	}
	if (value && typeof value === "object") {
		try {
			const json = JSON.stringify(value);
			if (json && json !== "{}") return json;
		} catch {
			// circular / non-serializable — fall through to the fallback
		}
		return fallback;
	}
	const s = String(value);
	return s.length > 0 ? s : fallback;
}

/** Stamp a sub-job's outcome. Best-effort: swallows KV errors so it can't fail the tick.
 *
 * Enforces the invariant `ok === false` implies `error` is present (#1480). Callers are
 * expected to supply the text, but the guarantee lives HERE rather than in each caller so a
 * future call site cannot silently reintroduce an undiagnosable red beat. */
export async function recordHeartbeat(env: RtEnv, name: CronJob, ok: boolean, error?: string): Promise<void> {
	try {
		const beat: Heartbeat = { ok, at: Date.now() };
		if (error) beat.error = error.slice(0, 300);
		else if (!ok) beat.error = "failed with no error text recorded";
		await env.OAUTH_KV?.put(PREFIX + name, JSON.stringify(beat));
		// Queryable analytics (#220): "which cron sub-job fails most often" over time,
		// not just the latest scalar heartbeat this KV key holds.
		recordAnalyticsEvent(env, "cron_heartbeat", { blobs: [name, ok ? "ok" : "fail", beat.error ?? null], doubles: [ok ? 1 : 0] });
	} catch {
		// heartbeat is observability-only; never let it fail the tick.
	}
}

/** A tick's soft-failure signal: the tick functions deliberately catch their own internal
 * failures and RETURN a report instead of throwing (so one bad message/step doesn't sink the
 * whole cycle), surfacing the failure as a top-level `error` string on that report (e.g.
 * self-improve's tick, or a vault-append that threw). A thrown exception is the hard-failure
 * path; this is the soft one — both must flip the heartbeat, or a job whose visible output has
 * been silently broken for weeks still reports ok. Returns the error text if the resolved report
 * carries one, else undefined. Benign no-op states (dormant/skipped/dry-run) use `note`, never
 * `error`, so they stay healthy. */
export function subJobError(report: unknown): string | undefined {
	if (report && typeof report === "object") {
		const err = (report as { error?: unknown }).error;
		// Falsy (absent/null/false/""/0) is the benign "no error" case and must stay ok=true.
		// Anything truthy is a failure regardless of its TYPE — an Error or a structured
		// object used to slip through the old string-only check and be recorded as ok=true.
		if (err) return errorText(err, "sub-job reported a non-descriptive error");
	}
	return undefined;
}

/** Run one named sub-job, record its heartbeat, and swallow failures so a single bad
 * sub-job neither throws nor blocks the rest of the tick (mirrors the prior per-job
 * try/catch, now with a persisted outcome instead of only a console.warn). A thrown
 * exception AND a soft failure the tick reports via `error` on its resolved report both
 * stamp ok=false. */
export async function runSubJob(env: RtEnv, name: CronJob, fn: () => Promise<unknown>): Promise<void> {
	try {
		const report = await fn();
		const soft = subJobError(report);
		if (soft) {
			console.warn(`sux scheduled ${name} reported a failure: ${soft}`);
			await recordHeartbeat(env, name, false, soft);
		} else {
			await recordHeartbeat(env, name, true);
		}
	} catch (e) {
		const msg = errorText(e, `${name} threw a non-descriptive error`);
		console.warn(`sux scheduled ${name} skipped: ${msg}`);
		await recordHeartbeat(env, name, false, msg);
	}
}

type KVLike = { get(key: string): Promise<string | null> };

/** Read every sub-job heartbeat and derive its staleness at `now`. Pure over a
 * KV-like reader so it's testable; a missing/unparseable beat degrades to
 * { seen: false } and never throws. */
export async function readHeartbeats(kv: KVLike | undefined, now = Date.now()): Promise<Record<string, unknown>> {
	const entries = await Promise.all(
		CRON_JOBS.map(async (name) => {
			let beat: Partial<Heartbeat> | null = null;
			try {
				const raw = await kv?.get(PREFIX + name);
				if (raw) beat = JSON.parse(raw) as Partial<Heartbeat>;
			} catch {
				beat = null;
			}
			if (!beat || typeof beat.at !== "number") return [name, { seen: false }] as const;
			const age_ms = now - beat.at;
			return [
				name,
				{
					seen: true,
					ok: Boolean(beat.ok),
					at: beat.at,
					age_ms,
					stale: age_ms > CRON_STALE_MS,
					...(beat.error ? { error: beat.error } : {}),
				},
			] as const;
		}),
	);
	return Object.fromEntries(entries);
}

// --- watch heartbeats (#1414) ------------------------------------------------
//
// Local "watch" scheduled tasks (deterministic check.sh probes running on the
// user's own machine, e.g. the retired mychart-doors pattern) have no cron tick
// of ours to hang a CRON_JOBS entry off of — they're external processes with
// caller-declared names and cadences, not a fixed list we control. This is a
// PARALLEL keyspace to the CRON_JOBS machinery above (separate prefix, separate
// storage shape), deliberately NOT added to CRON_JOBS: a watch name is arbitrary
// caller-supplied text, not a member of our fixed sub-job enum, and mixing the
// two would let a POST body grow that const's cardinality without a code change.

const WATCH_PREFIX = "sux:watch:heartbeat:";

// Every watch declares its own cadence (a daily probe and an hourly probe don't
// share one staleness window), so — unlike CRON_STALE_MS — the threshold rides
// along in the stored record itself and defaults to the same 26h grace window
// when the poster doesn't supply one.
export type WatchHeartbeat = { ok: boolean; at: number; error?: string; staleAfterMs?: number };

/** A watch `name` is arbitrary text lifted straight from a POST body into a KV key
 * segment — trim it, cap its length, and replace anything that isn't a safe key
 * character so a malformed body can't write to an unbounded/weird keyspace. Not
 * meant to be bulletproof, just enough that "" or a pathological name can't land. */
function sanitizeWatchName(name: unknown): string | null {
	if (typeof name !== "string") return null;
	const trimmed = name.trim();
	if (!trimmed) return null;
	const cleaned = trimmed.slice(0, 100).replace(/[^a-zA-Z0-9_.:-]/g, "_");
	return cleaned || null;
}

/** Stamp a watch's outcome. Mirrors recordHeartbeat's best-effort contract exactly:
 * swallows KV errors so it can never fail the poster's request, truncates error to
 * 300 chars, and defaults a non-ok beat's error to a non-empty fallback string. An
 * unusable `name` (see sanitizeWatchName) is a silent no-op, same "never throws"
 * guarantee as everything else here. */
export async function recordWatchHeartbeat(env: RtEnv, name: string, ok: boolean, error?: string, staleAfterMs?: number): Promise<void> {
	try {
		const safeName = sanitizeWatchName(name);
		if (!safeName) return;
		const beat: WatchHeartbeat = { ok, at: Date.now() };
		if (error) beat.error = error.slice(0, 300);
		else if (!ok) beat.error = "failed with no error text recorded";
		if (typeof staleAfterMs === "number" && Number.isFinite(staleAfterMs) && staleAfterMs > 0) beat.staleAfterMs = staleAfterMs;
		await env.OAUTH_KV?.put(WATCH_PREFIX + safeName, JSON.stringify(beat));
	} catch {
		// heartbeat is observability-only; never let it fail the poster's request.
	}
}

type WatchKVLike = KVLike & {
	list(opts: { prefix: string; cursor?: string }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
};

// Pagination safety valve: a watch keyspace is expected to stay small (a handful
// of local check.sh probes), but cap the scan rather than loop unbounded if it
// somehow doesn't.
const WATCH_LIST_MAX_PAGES = 20;

/** Read every watch heartbeat under WATCH_PREFIX and derive its staleness at `now`.
 * UNLIKE readHeartbeats (which iterates the fixed CRON_JOBS list), watch names are
 * caller-supplied and unbounded, so this enumerates the KV keyspace via list()
 * instead. Never throws: a malformed/unparseable entry is skipped rather than
 * aborting the read, and any list()/get() failure (or a KV binding that doesn't
 * support list at all) degrades to {}. */
export async function readWatchHeartbeats(kv: WatchKVLike | undefined, now = Date.now()): Promise<Record<string, unknown>> {
	if (!kv || typeof kv.list !== "function") return {};
	try {
		const out: Record<string, unknown> = {};
		let cursor: string | undefined;
		let pages = 0;
		do {
			const page = await kv.list({ prefix: WATCH_PREFIX, cursor });
			for (const k of page.keys) {
				const name = k.name.slice(WATCH_PREFIX.length);
				let beat: Partial<WatchHeartbeat> | null = null;
				try {
					const raw = await kv.get(k.name);
					if (raw) beat = JSON.parse(raw) as Partial<WatchHeartbeat>;
				} catch {
					beat = null;
				}
				if (!beat || typeof beat.at !== "number") continue;
				const age_ms = now - beat.at;
				const staleAfterMs = typeof beat.staleAfterMs === "number" && Number.isFinite(beat.staleAfterMs) && beat.staleAfterMs > 0 ? beat.staleAfterMs : CRON_STALE_MS;
				out[name] = {
					seen: true,
					ok: Boolean(beat.ok),
					at: beat.at,
					age_ms,
					stale: age_ms > staleAfterMs,
					...(beat.error ? { error: beat.error } : {}),
				};
			}
			cursor = page.list_complete ? undefined : page.cursor;
			pages++;
		} while (cursor && pages < WATCH_LIST_MAX_PAGES);
		return out;
	} catch {
		return {};
	}
}
