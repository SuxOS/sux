import { describe, expect, it } from "vitest";
import { CRON_STALE_MS, readHeartbeats, readWatchHeartbeats, recordHeartbeat, recordWatchHeartbeat, runSubJob } from "./cron-heartbeat";

const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) };
};

const K = (name: string) => `sux:cron:heartbeat:${name}`;

describe("recordHeartbeat / runSubJob (writer)", () => {
	it("runSubJob stamps ok=true after a clean sub-job", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		let ran = false;
		await runSubJob(env, "mail_triage", async () => void (ran = true));
		expect(ran).toBe(true);
		expect(JSON.parse(kv.store.get(K("mail_triage"))!)).toMatchObject({ ok: true });
	});

	it("runSubJob swallows a throwing sub-job and stamps ok=false + error", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await expect(runSubJob(env, "self_improve", async () => { throw new Error("boom"); })).resolves.toBeUndefined();
		const beat = JSON.parse(kv.store.get(K("self_improve"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBe("boom");
	});

	it("stamps ok=false when a sub-job resolves a report carrying an `error` (soft failure)", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "briefing", async () => ({ cycle: "d1", digest_written: false, error: "digest append failed: 503" }));
		const beat = JSON.parse(kv.store.get(K("briefing"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBe("digest append failed: 503");
	});

	it("keeps ok=true for a benign no-op report (dormant/skipped carry `note`, not `error`)", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "weekly_recall", async () => ({ dormant: true, note: "weekly_recall is disabled" }));
		expect(JSON.parse(kv.store.get(K("weekly_recall"))!)).toMatchObject({ ok: true });
	});

	// #1480: the live heartbeat showed mail_triage as { ok: false } with NO `error` key,
	// which runSubJob is the only writer for. An Error whose `.message` is "" lands on the
	// throw path as `String("" ?? e)` — `??` does not fall through, because "" is not
	// nullish — so recordHeartbeat's `if (error)` drops it. The result is a red sub-job
	// that is undiagnosable from outside: ok=false and nothing saying why.
	it("records a diagnosable error when the thrown Error has an empty message", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "mail_triage", async () => { throw new Error(""); });
		const beat = JSON.parse(kv.store.get(K("mail_triage"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBeTruthy();
	});

	it("records a diagnosable error when a non-Error falsy value is thrown", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		// eslint-disable-next-line no-throw-literal
		await runSubJob(env, "adblock", async () => { throw ""; });
		const beat = JSON.parse(kv.store.get(K("adblock"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBeTruthy();
	});

	// The mirror-image hole on the soft path: subJobError only accepts a string, so a tick
	// reporting `error` as an Error/object silently takes the success branch. A failure
	// recorded as ok=true is strictly worse than one recorded without its text.
	it("stamps ok=false when a report carries a non-string truthy `error`", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "briefing", async () => ({ error: new Error("upstream 503") }));
		const beat = JSON.parse(kv.store.get(K("briefing"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBeTruthy();
	});

	it("stamps ok=false when a report carries a structured `error` object", async () => {
		const kv = fakeKV();
		const env = { OAUTH_KV: kv } as any;
		await runSubJob(env, "agenda", async () => ({ error: { code: 503, detail: "upstream" } }));
		const beat = JSON.parse(kv.store.get(K("agenda"))!);
		expect(beat.ok).toBe(false);
		expect(beat.error).toBeTruthy();
	});

	it("truncates long error text to keep the heartbeat bounded", async () => {
		const kv = fakeKV();
		await recordHeartbeat({ OAUTH_KV: kv } as any, "adblock", false, "x".repeat(1000));
		expect(JSON.parse(kv.store.get(K("adblock"))!).error).toHaveLength(300);
	});

	it("never throws when the KV binding is absent", async () => {
		await expect(runSubJob({} as any, "kroger_token", async () => {})).resolves.toBeUndefined();
	});
});

describe("readHeartbeats (staleness reader)", () => {
	it("reports { seen: false } for a sub-job that never ran", async () => {
		const cron: any = await readHeartbeats(fakeKV(), 1_000_000);
		expect(cron.mail_triage).toEqual({ seen: false });
	});

	it("flags a fresh healthy beat as not stale", async () => {
		const now = 10_000_000;
		const kv = fakeKV({ [K("mail_triage")]: JSON.stringify({ ok: true, at: now - 1000 }) });
		const cron: any = await readHeartbeats(kv, now);
		expect(cron.mail_triage).toMatchObject({ seen: true, ok: true, stale: false, age_ms: 1000 });
	});

	it("flags a beat older than the staleness window as stale", async () => {
		const now = 10_000_000;
		const kv = fakeKV({ [K("self_improve")]: JSON.stringify({ ok: true, at: now - CRON_STALE_MS - 1 }) });
		const cron: any = await readHeartbeats(kv, now);
		expect(cron.self_improve).toMatchObject({ seen: true, ok: true, stale: true });
	});

	it("degrades unparseable KV to { seen: false } without throwing", async () => {
		const kv = fakeKV({ [K("adblock")]: "not json" });
		const cron: any = await readHeartbeats(kv, 1_000_000);
		expect(cron.adblock).toEqual({ seen: false });
	});
});

// Watch heartbeats (#1414): a PARALLEL keyspace for local "watch" scheduled tasks
// (check.sh probes on the user's own machine) that have no cron tick of ours to key
// off of — caller-supplied name, caller-declared per-entry staleness cadence, and a
// list()-driven reader instead of iterating a fixed job list.
const WK = (name: string) => `sux:watch:heartbeat:${name}`;

const fakeWatchKv = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return {
		store,
		get: async (k: string) => store.get(k) ?? null,
		put: async (k: string, v: string) => void store.set(k, v),
		list: async (opts: { prefix: string; cursor?: string }) => {
			const all = [...store.keys()].filter((k) => k.startsWith(opts.prefix)).sort();
			const start = opts.cursor ? Number(opts.cursor) : 0;
			const limit = 2; // small page size to exercise pagination in tests
			const page = all.slice(start, start + limit);
			const list_complete = start + limit >= all.length;
			return { keys: page.map((name) => ({ name })), list_complete, cursor: list_complete ? undefined : String(start + limit) };
		},
	};
};

describe("recordWatchHeartbeat / readWatchHeartbeats (watch heartbeats)", () => {
	it("records an entry and reads it back with the default (26h) staleness", async () => {
		const kv = fakeWatchKv();
		const env = { OAUTH_KV: kv } as any;
		await recordWatchHeartbeat(env, "mychart-doors", true);
		const beat = JSON.parse(kv.store.get(WK("mychart-doors"))!);
		expect(beat).toMatchObject({ ok: true });
		expect(beat.staleAfterMs).toBeUndefined();

		const now = beat.at + 1000;
		const watch: any = await readWatchHeartbeats(kv, now);
		expect(watch["mychart-doors"]).toMatchObject({ seen: true, ok: true, age_ms: 1000, stale: false });
	});

	it("truncates a long error and stamps a fallback error when ok=false with none given", async () => {
		const kv = fakeWatchKv();
		const env = { OAUTH_KV: kv } as any;
		await recordWatchHeartbeat(env, "front-door-cam", false, "x".repeat(1000));
		expect(JSON.parse(kv.store.get(WK("front-door-cam"))!).error).toHaveLength(300);

		await recordWatchHeartbeat(env, "back-door-cam", false);
		expect(JSON.parse(kv.store.get(WK("back-door-cam"))!).error).toBeTruthy();
	});

	it("goes stale after its OWN staleAfterMs elapses, not the shared 26h CRON_STALE_MS", async () => {
		const kv = fakeWatchKv();
		const env = { OAUTH_KV: kv } as any;
		const customStaleAfterMs = 5 * 60 * 1000; // 5 minutes — far below CRON_STALE_MS
		await recordWatchHeartbeat(env, "fast-cadence-watch", true, undefined, customStaleAfterMs);
		const beat = JSON.parse(kv.store.get(WK("fast-cadence-watch"))!);
		expect(beat.staleAfterMs).toBe(customStaleAfterMs);

		// Still fresh under the custom window, but would be "fresh" under CRON_STALE_MS too —
		// prove the custom (shorter) window is actually the one being applied.
		const justUnder: any = await readWatchHeartbeats(kv, beat.at + customStaleAfterMs - 1);
		expect(justUnder["fast-cadence-watch"]).toMatchObject({ stale: false });

		const justOver: any = await readWatchHeartbeats(kv, beat.at + customStaleAfterMs + 1);
		expect(justOver["fast-cadence-watch"]).toMatchObject({ stale: true });
		expect(justOver["fast-cadence-watch"].age_ms).toBeLessThan(CRON_STALE_MS);
	});

	it("skips a malformed/unparseable entry rather than throwing, while still returning the rest", async () => {
		const kv = fakeWatchKv({
			[WK("broken")]: "not json",
			[WK("healthy")]: JSON.stringify({ ok: true, at: 1_000_000 }),
		});
		const watch: any = await readWatchHeartbeats(kv, 1_000_500);
		expect(watch.broken).toBeUndefined();
		expect(watch.healthy).toMatchObject({ seen: true, ok: true, age_ms: 500 });
	});

	it("degrades to {} when the KV binding doesn't support list", async () => {
		const kv = { get: async () => null } as any;
		const watch = await readWatchHeartbeats(kv);
		expect(watch).toEqual({});
	});

	it("degrades to {} when list() itself errors", async () => {
		const kv = { get: async () => null, list: async () => { throw new Error("kv unavailable"); } } as any;
		const watch = await readWatchHeartbeats(kv);
		expect(watch).toEqual({});
	});

	it("never throws and no-ops when the name is empty or unusable", async () => {
		const kv = fakeWatchKv();
		const env = { OAUTH_KV: kv } as any;
		await expect(recordWatchHeartbeat(env, "", true)).resolves.toBeUndefined();
		await expect(recordWatchHeartbeat(env, "   ", true)).resolves.toBeUndefined();
		expect(kv.store.size).toBe(0);
	});

	it("paginates across multiple list() pages (fake KV pages at 2 keys)", async () => {
		const kv = fakeWatchKv({
			[WK("a")]: JSON.stringify({ ok: true, at: 1000 }),
			[WK("b")]: JSON.stringify({ ok: true, at: 1000 }),
			[WK("c")]: JSON.stringify({ ok: true, at: 1000 }),
		});
		const watch: any = await readWatchHeartbeats(kv, 2000);
		expect(Object.keys(watch).sort()).toEqual(["a", "b", "c"]);
	});
});
