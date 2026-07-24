// Server-side feedback log for sux — the `issue` / `suggest` functions append
// here (KV), and GET /feedback reads it back. This gives the Worker its OWN
// backlog (independent of Claude's cross-conversation memory), closing the loop
// the Worker itself can act on. Newest-first, capped.
import { keyedSerialize } from "../keyed-serialize";
import { cappedKvLog } from "./_capped_kv_log";
import { redactPII } from "./redact";
import type { RtEnv } from "../registry";

export type FeedbackKind = "issue" | "suggest";
export type FeedbackEntry = {
	kind: FeedbackKind;
	text: string;
	at: number;
	tool?: string;
	/** Set once this entry has been reconciled elsewhere (a filed GitHub issue, a manual
	 *  sweep, …) — GET /feedback excludes resolved entries by default (?all=true to see
	 *  them), so the log stays a useful "what's still outstanding" view instead of growing
	 *  forever with entries already tracked somewhere else. */
	resolved?: { at: number; tracked_by?: string };
};

const KEY = "sux:feedback";
const CAP = 500;
// Bound any single entry's text so one pasted essay/scrape can't dominate the
// blob's byte budget — feedback is meant to be a short note, not a document.
const MAX_TEXT_CHARS = 4000;

// Serializes appends to the single feedback key within an isolate so two concurrent
// issue()/suggest() calls don't clobber each other's just-appended entry (lost-update
// race). Per-isolate only; a cross-isolate collision still loses one (a DO would not).
const appendChains = new Map<string, Promise<unknown>>();

const log = (env: RtEnv) => cappedKvLog<FeedbackEntry>(env, KEY, CAP);

/** Append an entry (optionally tagged with the tool it's about); returns its 1-based number (total) and timestamp. */
export async function appendFeedback(env: RtEnv, kind: FeedbackKind, text: string, tool?: string): Promise<{ total: number; at: number }> {
	return keyedSerialize(appendChains, KEY, async () => {
		const at = Date.now();
		// GET /feedback is public + unauthenticated, so scrub PII the agent may have
		// relayed from a scrape or vault/mail excerpt before it lands verbatim there.
		const items = await log(env).push({ kind, text: redactPII(text).redacted.slice(0, MAX_TEXT_CHARS), at, ...(tool ? { tool } : {}) });
		return { total: items.length, at };
	});
}

/** Read entries (optionally filtered by kind and/or tool), newest first. Resolved entries
 *  are excluded unless `includeResolved` — the default is "what's still outstanding". */
export async function readFeedback(env: RtEnv, kind?: FeedbackKind, limit = 50, tool?: string, includeResolved = false): Promise<FeedbackEntry[]> {
	let items = await log(env).load();
	if (!includeResolved) items = items.filter((i) => !i.resolved);
	if (kind) items = items.filter((i) => i.kind === kind);
	if (tool) items = items.filter((i) => i.tool === tool);
	return items.slice(0, Math.max(0, limit));
}

/** Mark every entry at timestamp `at` (optionally narrowed to `kind`, since `at` alone is
 *  the only stable handle GET /feedback exposes) as resolved/superseded — e.g. once it's
 *  been manually reconciled into a tracked GitHub issue. Idempotent: an already-resolved
 *  entry is left alone. Returns how many entries were newly resolved (0 = no match, so the
 *  caller can report "nothing found" instead of silently no-oping). Uses the log's `update`
 *  (not `push`) so this chains onto the same per-key write lock as a concurrent append/
 *  resolve rather than racing it with a stale snapshot. */
export async function resolveFeedback(env: RtEnv, at: number, opts: { kind?: FeedbackKind; tracked_by?: string } = {}): Promise<number> {
	let matched = 0;
	await log(env).update((items) => {
		const next = items.map((it) => {
			if (it.resolved || it.at !== at || (opts.kind && it.kind !== opts.kind)) return it;
			matched++;
			return { ...it, resolved: { at: Date.now(), ...(opts.tracked_by ? { tracked_by: opts.tracked_by } : {}) } };
		});
		return matched ? next : items;
	});
	return matched;
}
