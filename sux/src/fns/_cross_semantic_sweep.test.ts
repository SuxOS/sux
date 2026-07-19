import { describe, expect, it } from "vitest";
import { hasCrossSemanticSweep, lastCrossSemanticFindings, runCrossSemanticSweep, type CrossSemanticSweepDeps } from "./_cross_semantic_sweep";
import { runSubJob } from "../cron-heartbeat";
import type { CrossLink } from "./_cross_semantic";

// A single OAUTH_KV stub for the ledger — mirrors _consolidate.test.ts's fakeKV. The whole
// feature is exercised through injected deps: no real vault/mail/files semantic index.
const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const envWith = (flags: Record<string, string | undefined> = {}) => ({ OAUTH_KV: fakeKV(), CROSS_SEMANTIC_ENABLED: "1", ...flags }) as any;

const link = (vaultPath: string, key: string, score = 0.9): CrossLink => ({ vaultPath, domain: "mail", key, label: key, score });

const mkDeps = (candidates: CrossLink[]): CrossSemanticSweepDeps & { calls: number } => {
	const deps = { calls: 0, buildCandidates: async () => { deps.calls++; return candidates; } };
	return deps;
};

describe("gate — fail-closed", () => {
	it("hasCrossSemanticSweep requires BOTH CROSS_SEMANTIC_ENABLED and CROSS_SEMANTIC_SWEEP_ENABLED", () => {
		expect(hasCrossSemanticSweep({} as any)).toBe(false);
		expect(hasCrossSemanticSweep({ CROSS_SEMANTIC_ENABLED: "1" } as any)).toBe(false);
		expect(hasCrossSemanticSweep({ CROSS_SEMANTIC_SWEEP_ENABLED: "1" } as any)).toBe(false);
		expect(hasCrossSemanticSweep({ CROSS_SEMANTIC_ENABLED: "1", CROSS_SEMANTIC_SWEEP_ENABLED: "1" } as any)).toBe(true);
		for (const v of ["0", "false", "no", "off"]) expect(hasCrossSemanticSweep({ CROSS_SEMANTIC_ENABLED: "1", CROSS_SEMANTIC_SWEEP_ENABLED: v } as any)).toBe(false);
	});
});

describe("runCrossSemanticSweep", () => {
	it("is a dormant no-op unless enabled — never ranks anything", async () => {
		const deps = mkDeps([link("A.md", "m1")]);
		const report = await runCrossSemanticSweep(envWith(), { week: "2026-W01" }, deps);
		expect(report.dormant).toBe(true);
		expect(deps.calls).toBe(0);
	});

	it("caches the ranked batch and reports the count", async () => {
		const env = envWith({ CROSS_SEMANTIC_SWEEP_ENABLED: "1" });
		const deps = mkDeps([link("A.md", "m1"), link("B.md", "m2")]);
		const report = await runCrossSemanticSweep(env, { week: "2026-W10" }, deps);
		expect(report.dormant).toBeUndefined();
		expect(report.candidate_count).toBe(2);
		expect(deps.calls).toBe(1);
	});

	it("is idempotent per ISO week — a second same-week tick skips without re-ranking", async () => {
		const env = envWith({ CROSS_SEMANTIC_SWEEP_ENABLED: "1" });
		const d1 = mkDeps([link("A.md", "m1")]);
		await runCrossSemanticSweep(env, { week: "2026-W20" }, d1);
		expect(d1.calls).toBe(1);
		const d2 = mkDeps([link("A.md", "m1")]);
		const report2 = await runCrossSemanticSweep(env, { week: "2026-W20" }, d2);
		expect(report2.skipped).toBe(true);
		expect(d2.calls).toBe(0);
	});

	it("force re-runs even a marked week", async () => {
		const env = envWith({ CROSS_SEMANTIC_SWEEP_ENABLED: "1" });
		const d1 = mkDeps([link("A.md", "m1")]);
		await runCrossSemanticSweep(env, { week: "2026-W30" }, d1);
		const d2 = mkDeps([link("A.md", "m1"), link("B.md", "m2")]);
		const report = await runCrossSemanticSweep(env, { week: "2026-W30", force: true }, d2);
		expect(report.skipped).toBeUndefined();
		expect(d2.calls).toBe(1);
		expect(report.candidate_count).toBe(2);
	});

	it("a failed rank pass leaves the week UNMARKED so the next tick retries", async () => {
		const env = envWith({ CROSS_SEMANTIC_SWEEP_ENABLED: "1" });
		const failing: CrossSemanticSweepDeps = { buildCandidates: async () => { throw new Error("index down"); } };
		const r1 = await runCrossSemanticSweep(env, { week: "2026-W40" }, failing);
		expect(r1.error).toMatch(/index down/);
		const ok = mkDeps([link("A.md", "m1")]);
		const r2 = await runCrossSemanticSweep(env, { week: "2026-W40" }, ok);
		expect(r2.skipped).toBeUndefined();
		expect(r2.candidate_count).toBe(1);
	});

	it("caches the sweep's findings for lastCrossSemanticFindings to read (the agenda loop's feed)", async () => {
		const env = envWith({ CROSS_SEMANTIC_SWEEP_ENABLED: "1" });
		expect(await lastCrossSemanticFindings(env)).toBeNull();
		const deps = mkDeps([link("A.md", "m1")]);
		await runCrossSemanticSweep(env, { week: "2026-W50" }, deps);
		const findings = await lastCrossSemanticFindings(env);
		expect(findings?.week).toBe("2026-W50");
		expect(findings?.candidate_count).toBe(1);
		expect(findings?.candidates[0]).toMatchObject({ vaultPath: "A.md", key: "m1" });
	});

	it("an empty batch caches candidate_count 0, not null", async () => {
		const env = envWith({ CROSS_SEMANTIC_SWEEP_ENABLED: "1" });
		const deps = mkDeps([]);
		await runCrossSemanticSweep(env, { week: "2026-W51" }, deps);
		const findings = await lastCrossSemanticFindings(env);
		expect(findings?.candidate_count).toBe(0);
		expect(findings?.candidates).toEqual([]);
	});

	it("a rank-pass failure flips the cron heartbeat unhealthy via runSubJob/subJobError", async () => {
		const env = envWith({ CROSS_SEMANTIC_SWEEP_ENABLED: "1" });
		const failing: CrossSemanticSweepDeps = { buildCandidates: async () => { throw new Error("semantic index unreachable"); } };
		await runSubJob(env, "cross_semantic_sweep", () => runCrossSemanticSweep(env, { week: "2026-W60" }, failing));
		const beat = JSON.parse(await env.OAUTH_KV.get("sux:cron:heartbeat:cross_semantic_sweep"));
		expect(beat.ok).toBe(false);
		expect(beat.error).toContain("semantic index unreachable");
	});
});
