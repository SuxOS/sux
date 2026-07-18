import type { RtEnv } from "../registry";
import { cosine } from "./_embed";
import type { SemanticChunk } from "./_vault_semantic";
import type { MailSemanticChunk } from "./_mail_semantic";
import type { FilesSemanticChunk } from "./_files_semantic";

// Cross-domain semantic linking (#785): the three domain indices (_vault_semantic.ts,
// _mail_semantic.ts, _files_semantic.ts) are only ever combined ephemerally, inside one
// recall.ts question at a time. This module runs them against EACH OTHER to find standing
// cross-domain relationships and propose them as durable, human-approved backlinks
// (op-engine/registry.ts's `cross-semantic-relate` op, fns/cross_semantic_relate.ts).
//
// Deliberately vault-anchored, same "deliberately narrow" spirit _consolidate.ts's
// basename-only duplicate detector documents about itself: every candidate pair has a vault
// note on one side, since the vault is the only domain this repo can durably annotate with a
// free-text backlink today (mail only has labels; files has no write path at all) — a
// mail↔files-only pair (no vault side) is out of scope for V1.

const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "")
		.trim()
		.toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** SAFETY (fail-closed): CROSS_SEMANTIC_ENABLED unset ⇒ total no-op (dormant), same idiom as
 *  CONSOLIDATE_ENABLED/WEEKLY_RECALL_ENABLED (registry.ts). */
export const hasCrossSemantic = (env: RtEnv): boolean => flagOn(env.CROSS_SEMANTIC_ENABLED);

// Cross-domain similarity is noisier than same-domain (email previews, vault prose, and file
// text have different length/style distributions — #785's own honest caveat), so the bar sits
// well above what recall.ts's same-domain topK legs need (they take top-5 unthresholded) —
// a compile-time literal, not env-configurable, mirroring §7's "rate caps are compile-time
// literals" principle for anything that gates an autonomous batch size/quality bar.
const SIM_THRESHOLD = 0.75;
const EXCERPT_CHARS = 240;

export type CrossSemanticCandidate = {
	vaultPath: string;
	vaultTitle: string;
	vaultExcerpt: string;
	relatedDomain: "mail" | "files";
	relatedRef: string;
	relatedTitle: string;
	relatedExcerpt: string;
	score: number;
};

type Rep = { ref: string; title: string; text: string; embedding: number[] };

/** One representative chunk per document (its FIRST chunk, not every chunk) — bounds the
 *  pairwise scan to O(#documents) rather than O(#chunks) (a long note/email/file can produce
 *  many chunks) and keeps each side of a comparison a whole-document-representative fragment
 *  instead of an arbitrary mid-document slice, which is also less noisy for a cross-domain
 *  score. Chunks that failed to embed are skipped, same convention as topKByCosine. */
function representatives<T extends { text: string; embedding: number[] }>(chunks: T[], refOf: (c: T) => string, titleOf: (c: T) => string): Rep[] {
	const seen = new Set<string>();
	const out: Rep[] = [];
	for (const c of chunks) {
		if (!Array.isArray(c.embedding) || !c.embedding.length) continue;
		const ref = refOf(c);
		if (seen.has(ref)) continue;
		seen.add(ref);
		out.push({ ref, title: titleOf(c), text: c.text, embedding: c.embedding });
	}
	return out;
}

function excerpt(text: string): string {
	const t = text.trim().replace(/\s+/g, " ");
	return t.length > EXCERPT_CHARS ? `${t.slice(0, EXCERPT_CHARS)}…` : t;
}

function bestMatches(vaultReps: Rep[], otherReps: Rep[], relatedDomain: "mail" | "files"): CrossSemanticCandidate[] {
	const out: CrossSemanticCandidate[] = [];
	for (const v of vaultReps) {
		for (const o of otherReps) {
			const score = cosine(v.embedding, o.embedding);
			if (score < SIM_THRESHOLD) continue;
			out.push({
				vaultPath: v.ref,
				vaultTitle: v.title,
				vaultExcerpt: excerpt(v.text),
				relatedDomain,
				relatedRef: o.ref,
				relatedTitle: o.title,
				relatedExcerpt: excerpt(o.text),
				score,
			});
		}
	}
	return out;
}

/** Score every vault note against every mail/files document (representative chunks only —
 *  see `representatives`), keep pairs at or above SIM_THRESHOLD, and return the strongest
 *  `maxPairs` overall (across both domain pairs, ranked together so the batch surfaces the
 *  genuinely strongest matches first). Any index that's null (domain unconfigured, no HEAD,
 *  no AI binding, …) contributes nothing rather than erroring — same graceful-degrade
 *  contract recall.ts's per-source fetch already uses. No vault index ⇒ no candidates at all,
 *  since every candidate needs a vault side. */
export function computeCrossSemanticCandidates(
	vault: { chunks: SemanticChunk[] } | null,
	mail: { chunks: MailSemanticChunk[] } | null,
	files: { chunks: FilesSemanticChunk[] } | null,
	maxPairs = 20,
): CrossSemanticCandidate[] {
	if (!vault?.chunks?.length) return [];
	const vaultReps = representatives(
		vault.chunks,
		(c) => c.path,
		(c) => c.title,
	);
	const candidates: CrossSemanticCandidate[] = [];
	if (mail?.chunks?.length) {
		const mailReps = representatives(
			mail.chunks,
			(c) => c.id,
			(c) => c.subject,
		);
		candidates.push(...bestMatches(vaultReps, mailReps, "mail"));
	}
	if (files?.chunks?.length) {
		const filesReps = representatives(
			files.chunks,
			(c) => c.path,
			(c) => c.path.split("/").pop() ?? c.path,
		);
		candidates.push(...bestMatches(vaultReps, filesReps, "files"));
	}
	return candidates.sort((a, b) => b.score - a.score).slice(0, Math.max(1, maxPairs));
}
