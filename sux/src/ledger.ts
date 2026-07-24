import { errMsg } from "./prim";
import { type RtEnv } from "./registry";

// A tiny idempotency ledger over OAUTH_KV: "have I already done X?" so batch sweeps
// converge on re-run instead of re-doing work. Namespaced, TTL'd. markIfNew is the
// gate — true the FIRST time an id is seen (and it records it), false thereafter.
// NOT atomic (Cloudflare KV has no compare-and-set): the small race is acceptable for
// idempotency — worst case is a rare double-process, which a well-formed sweep already
// tolerates. With no KV binding it degrades to "always new" (can't dedupe, never throws).

const PREFIX = "sux:ledger:";
const keyOf = (ns: string, id: string) => `${PREFIX}${ns}:${id}`;

export type OnceResult = { ran: boolean; marked: boolean; error?: string };

export type Ledger = {
	/** Has this id been recorded in this namespace? */
	seen: (id: string) => Promise<boolean>;
	/** The recorded value for this id, or null if never marked (or no KV binding). */
	get: (id: string) => Promise<string | null>;
	/** Record this id (TTL'd). */
	mark: (id: string, value?: string) => Promise<void>;
	/** Record iff new — returns true the first time (and records), false if already seen. */
	markIfNew: (id: string, value?: string) => Promise<boolean>;
	/** The commit-after-success primitive (#1424): run `fn` only if `id` is unseen, and mark
	 *  `id` IFF `fn` resolves — never before, so a failed side effect (a vault append, a sent
	 *  email) leaves the id unmarked and the next tick retries it, instead of the hand-rolled
	 *  seen→do→mark discipline every autonomous loop used to reimplement (and could get wrong
	 *  in either direction: marking before the work lands, or marking even when it throws).
	 *  These loops must never fail their whole cycle over one skipped side effect, so `once`
	 *  reports the failure in the return value rather than propagating it — callers that used
	 *  to swallow a thrown error around a hand-rolled block get the same swallow here, just
	 *  with the ok/marked signal made explicit instead of implicit in whether mark() ran. */
	once: (id: string, fn: () => Promise<unknown>, value?: string) => Promise<OnceResult>;
};

/** Open a namespaced idempotency ledger. ttlSeconds (default 30d) auto-expires entries; clamped to KV's 60s floor. */
export function ledger(env: RtEnv, ns: string, ttlSeconds = 30 * 24 * 3600): Ledger {
	const kv = env.OAUTH_KV;
	const ttl = { expirationTtl: Math.max(60, ttlSeconds) };
	return {
		async seen(id) {
			return Boolean(await kv?.get(keyOf(ns, id)));
		},
		async get(id) {
			return (await kv?.get(keyOf(ns, id))) ?? null;
		},
		async mark(id, value = "1") {
			await kv?.put(keyOf(ns, id), value, ttl);
		},
		async markIfNew(id, value = "1") {
			if (await kv?.get(keyOf(ns, id))) return false;
			await kv?.put(keyOf(ns, id), value, ttl);
			return true;
		},
		async once(id, fn, value = "1") {
			if (await kv?.get(keyOf(ns, id))) return { ran: false, marked: false };
			try {
				await fn();
			} catch (e) {
				return { ran: true, marked: false, error: errMsg(e) };
			}
			await kv?.put(keyOf(ns, id), value, ttl);
			return { ran: true, marked: true };
		},
	};
}

/** A short content fingerprint (first 8 bytes of SHA-256, hex) for idempotency keys — bounded, collision-safe enough within a namespace. */
export async function fingerprint(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf).slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
