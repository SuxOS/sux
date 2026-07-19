// Cross-domain semantic backlink cron sweep (#948) — the missing proactive half of #785's
// vault_cross_link_plan.ts. That entrypoint only ranks the vault's semantic index against
// mail+files on an explicit call; this rides the SAME weekly cadence as _consolidate.ts's
// stale/duplicate sweep, caches the resulting candidate batch, and lets _agenda.ts's
// detectCrossSemanticDrops surface "a batch of cross-domain links is ready to review" in the
// daily digest instead of requiring Colin to remember to call vault_cross_link_plan by hand.
//
// V1 SCOPE: DETECTION + CACHING ONLY. It never starts vault_cross_link_plan's durable
// approval run itself and never touches the vault — the only "write" is the bounded ledger
// cache the agenda loop reads. Reviewing/approving a batch is still exactly one manual
// vault_cross_link_plan call away, same as consolidate's stale/duplicate findings are.
//
// SAFETY (fail-closed): CROSS_SEMANTIC_SWEEP_ENABLED unset ⇒ total no-op (dormant), same as
// every other cron-sweep gate here. ALSO requires CROSS_SEMANTIC_ENABLED (the base capability
// vault_cross_link_plan itself needs) — a sweep flag alone can't arm ranking the manual
// entrypoint itself refuses to do (mirrors hasAgendaEmail's nested-gate shape).
import type { RtEnv } from "../registry";
import { ledger } from "../ledger";
import { errMsg } from "./_util";
import { isoWeek } from "./_weekly_recall";
import { hasCrossSemantic, crossDomainLinks, filesToCrossItems, mailToCrossItems, type CrossDomainItem, type CrossLink } from "./_cross_semantic";
import { vaultCfg } from "./obsidian";

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The sweep may run at all. Requires BOTH its own flag and the base cross-semantic
 *  capability vault_cross_link_plan itself needs — unset either ⇒ dormant. */
export const hasCrossSemanticSweep = (env: RtEnv): boolean => hasCrossSemantic(env) && flagOn(env.CROSS_SEMANTIC_SWEEP_ENABLED);

/** The ledger key holding the most recent successful sweep's candidate batch, so a read-only
 *  consumer (_agenda.ts's detectCrossSemanticDrops) can pick it up without re-ranking. */
const LAST_REPORT_KEY = "last-report";

/** Caps how many candidate pairs the cached last-report carries — enough for a digest count,
 *  not the full batch (mirrors _consolidate.ts's MAX_CACHED_FINDINGS). */
const MAX_CACHED_CANDIDATES = 20;

export type CrossSemanticFindings = { week: string; candidates: CrossLink[]; candidate_count: number };

/** The most recent successful sweep's findings (bounded to MAX_CACHED_CANDIDATES), read from
 *  the ledger cache — never re-ranks. Returns null if the sweep has never completed a cycle
 *  (dormant, KV unavailable, or a corrupt/missing cache entry). */
export async function lastCrossSemanticFindings(env: RtEnv): Promise<CrossSemanticFindings | null> {
	const raw = await ledger(env, "cross_semantic_sweep").get(LAST_REPORT_KEY);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed.week !== "string") return null;
		const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
		return { week: parsed.week, candidates, candidate_count: typeof parsed.candidate_count === "number" ? parsed.candidate_count : candidates.length };
	} catch {
		return null;
	}
}

export type CrossSemanticSweepDeps = {
	buildCandidates: (env: RtEnv) => Promise<CrossLink[]>;
};

export type CrossSemanticSweepReport = {
	week?: string;
	dormant?: boolean;
	skipped?: boolean;
	error?: string;
	candidates?: CrossLink[];
	candidate_count?: number;
	note?: string;
};

/** Run one sweep cycle. Fail-closed: dormant no-op unless hasCrossSemanticSweep. Idempotent
 *  per ISO week (mirrors _consolidate.ts's runConsolidate) — the daily cron re-fires this
 *  every day, but the real rank pass runs at most once per week; `opts.force` bypasses the
 *  gate for an on-demand call. Never writes to the vault — only caches the ranked batch for
 *  the agenda loop to read. The week is marked only after a successful rank pass, so a
 *  failure leaves it unmarked and the next tick retries. */
export async function runCrossSemanticSweep(env: RtEnv, opts: { week?: string; force?: boolean }, deps: CrossSemanticSweepDeps): Promise<CrossSemanticSweepReport> {
	if (!hasCrossSemanticSweep(env)) {
		return {
			dormant: true,
			note: "cross-semantic sweep is disabled — set CROSS_SEMANTIC_SWEEP_ENABLED (and CROSS_SEMANTIC_ENABLED) to have the weekly cron rank the vault's semantic index against mail+files and surface a ready batch through the agenda digest. Fail-closed: nothing runs until both flags are set.",
		};
	}
	const week = String(opts.week ?? isoWeek(env.VAULT_TZ));
	const led = ledger(env, "cross_semantic_sweep");
	const key = `week::${week}`;
	if (!opts.force && (await led.seen(key))) return { week, skipped: true, note: "already ran this ISO week" };

	let candidates: CrossLink[];
	try {
		candidates = await deps.buildCandidates(env);
	} catch (e) {
		const msg = `cross-semantic rank pass failed: ${errMsg(e)}`;
		return { week, error: msg, note: msg };
	}

	await led.mark(key);
	await led.mark(LAST_REPORT_KEY, JSON.stringify({ week, candidates: candidates.slice(0, MAX_CACHED_CANDIDATES), candidate_count: candidates.length }));

	return { week, candidates, candidate_count: candidates.length };
}

/** The real deps: rank the vault's semantic index against pooled mail+files targets, mirroring
 *  vault_cross_link_plan.ts's own fetch-then-rank shape exactly (same indices, same defaults).
 *  Dynamically imported so the cron path pulls in the semantic-index surface only when armed.
 *  A missing vault config, missing Workers-AI binding, or no mail/files targets yields an empty
 *  batch, not a thrown error — the same "nothing to link" degrade vault_cross_link_plan.ts
 *  itself uses. */
export async function defaultDeps(): Promise<CrossSemanticSweepDeps> {
	const { vaultSemanticIndex } = await import("./_vault_semantic");
	const { mailSemanticIndex } = await import("./_mail_semantic");
	const { filesSemanticIndex } = await import("./_files_semantic");
	return {
		buildCandidates: async (env) => {
			const cfg = vaultCfg(env);
			if ("error" in cfg) return [];
			const vaultIndex = await vaultSemanticIndex(env, cfg);
			if (!vaultIndex) return [];
			const [mailIndex, filesIndex] = await Promise.all([mailSemanticIndex(env), filesSemanticIndex(env)]);
			const targets: CrossDomainItem[] = [...(mailIndex ? mailToCrossItems(mailIndex.chunks) : []), ...(filesIndex ? filesToCrossItems(filesIndex.chunks) : [])];
			if (!targets.length) return [];
			return crossDomainLinks(vaultIndex.chunks, targets);
		},
	};
}
