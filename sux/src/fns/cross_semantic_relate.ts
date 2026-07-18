import { type Fn, failWith, ok } from "../registry";
import { runVerb } from "./run";
import { vaultSemanticIndex } from "./_vault_semantic";
import { mailSemanticIndex } from "./_mail_semantic";
import { filesSemanticIndex } from "./_files_semantic";
import { computeCrossSemanticCandidates, hasCrossSemantic } from "./_cross_semantic";
import { vaultCfg } from "./obsidian";
import { errMsg, oj } from "./_util";

// cross_semantic_relate — the entrypoint for the DURABLE, human-approved action-half of
// cross-domain semantic linking (#785): scores the vault/mail/files semantic indices (already
// built by recall.ts's own fan-out — vaultSemanticIndex/mailSemanticIndex/filesSemanticIndex)
// against each other with _cross_semantic.ts's computeCrossSemanticCandidates, then starts a
// `run` of the `cross-semantic-relate` op (op-engine/registry.ts), which PAUSES for one human
// "append these related backlinks?" approval before appending anything. Nothing is ever
// auto-applied — mirrors vault_consolidate_plan.ts's shape exactly (fetch-then-runVerb; a
// durable op leaf only sees `caps`, not env, so loading the three indices happens here).
// Gated behind CROSS_SEMANTIC_ENABLED (fail-closed).
const numClamp = (v: unknown, lo: number, hi: number, dflt: number): number => Math.min(hi, Math.max(lo, Math.floor(Number(v) || dflt)));

export const cross_semantic_relate: Fn = {
	name: "cross_semantic_relate",
	surface: "leaf",
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	description:
		"Durable cross-domain semantic linking with approval: scores the vault's, mail's, and files' existing semantic indices against each other for strong cross-domain matches (a vault note whose nearest neighbors are a specific email and/or Dropbox file), then starts a durable run (op:'cross-semantic-relate') that PAUSES for one human 'append these related backlinks?' approval before appending anything. On approval, each candidate gets an APPEND-only backlink pointer on the vault-side note — the vault note's own content and the mail/files side are never touched. Nothing is ever auto-applied. Returns {instanceId}: poll with `run {action:'status', instanceId}`; approve with `run {action:'answer', instanceId, prompt:\"append these related backlinks?\", payload:{approved:true}}`, or veto with {approved:false}. An unanswered gate applies nothing after 24h (fails closed). Needs CROSS_SEMANTIC_ENABLED and a configured vault (git-backed Obsidian) — mail/files sides are optional (a candidate needs a vault side but only ONE of mail/files, whichever indices are configured).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			maxPairs: { type: "integer", minimum: 1, maximum: 50, description: "Max related-pairs to propose this batch, strongest scores first (default 20)." },
		},
	},
	run: async (env, a) => {
		if (!hasCrossSemantic(env)) {
			return failWith("not_configured", "cross_semantic_relate is disabled — set CROSS_SEMANTIC_ENABLED to arm it. Nothing scanned or linked until it's set.");
		}
		const maxPairs = numClamp(a?.maxPairs, 1, 50, 20);
		try {
			const cfg = vaultCfg(env);
			const vaultIdxPromise = "error" in cfg ? Promise.resolve(null) : vaultSemanticIndex(env, cfg).catch(() => null);
			const [vaultIdx, mailIdx, filesIdx] = await Promise.all([vaultIdxPromise, mailSemanticIndex(env).catch(() => null), filesSemanticIndex(env).catch(() => null)]);
			const candidates = computeCrossSemanticCandidates(vaultIdx, mailIdx, filesIdx, maxPairs);
			if (!candidates.length) return ok(oj({ note: "no cross-domain related pairs found above threshold — nothing to link" }));
			const res = await runVerb({ op: "cross-semantic-relate", input: candidates, mode: "durable" }, env);
			return ok(
				oj({
					candidates: candidates.length,
					...res,
					note: 'durable run started — proposes an append-only "related" backlink per candidate pair, then pauses for a human \'append these related backlinks?\' approval. Poll with `run {action:\'status\', instanceId}`; approve/reject with `run {action:\'answer\', instanceId, prompt:"append these related backlinks?"}` ({approved:true|false}).',
				}),
			);
		} catch (e) {
			return failWith("upstream_error", errMsg(e));
		}
	},
};
