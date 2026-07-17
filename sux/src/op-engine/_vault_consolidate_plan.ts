// Leaf logic for the `vault-consolidate-plan` durable op (registry.ts): turns a batch of
// consolidate-detected duplicate CANDIDATES (paths + already-fetched content, from
// fns/_consolidate.ts's classifyNotes/duplicateKey grouping) into a batch of proposed,
// REVERSIBLE note merges — nothing else. Deliberately non-destructive: the canonical note
// gets the merged content (a `write`), the duplicate note is never deleted, only appended
// with a pointer back to the canonical note (an `append`) — so a wrong merge judgment is
// always undoable by hand (or `git revert`), mirroring `_mail_triage_plan.ts`'s
// "reversible-only" bar for what this durable-op tier is allowed to auto-apply after a
// single human approval.
import { runReconcile, type Caps } from "@suxos/lib";

// One cluster = one whole same-key GROUP (every note sharing a duplicateKey), not a pair —
// `classifyNotes` (fns/_consolidate.ts) still emits pairwise candidates for the digest's
// human-readable "a ↔ b" listing, but `vault_consolidate_plan.ts` collapses same-key pairs
// back into a single group before building this input. Exploding a group into pairwise
// clusters here would let each pair's independent proposeMerge overwrite `keep` with only
// its own two-note union, clobbering every earlier pair's merge (#764) — a group's `keep`
// must be resolved with ONE composed union over every member.
export type DuplicateClusterInput = { paths: string[]; contents: string[]; key: string };
export type MergePlanItem = { keep: string; archives: string[]; mergedContent: string; key: string };

/** Deterministic canonical pick: the lexicographically-first path always wins the "keep"
 *  slot and every other member becomes an "archive" — no external tie-break state needed, so
 *  replay (and two independent runs over the same group) always agree. */
function canonicalOrder(paths: string[]): [keep: string, archives: string[]] {
	const sorted = [...paths].sort();
	return [sorted[0], sorted.slice(1)];
}

/** Propose one GROUP's merge: content-address every member's current text and faithful-union
 *  them all in one pass (suxlib's op/reconcile.ts — the same dedup-by-content-block merge
 *  assimilate-pdfs already uses for its PDF pages, here folding N members instead of 2), so
 *  identical passages collapse instead of duplicating and the composed result reflects every
 *  member at once, then resolve the merged handle back to text for the sink to write. Returns
 *  null for a malformed cluster (fewer than 2 paths, or a missing/empty content) rather than
 *  throwing — one bad item must not sink the whole batch's `map` fan-out. */
export async function proposeMerge(c: DuplicateClusterInput, caps: Caps): Promise<MergePlanItem | null> {
	if (!c?.paths || c.paths.length < 2 || c.paths.length !== c.contents?.length || c.contents.some((t) => !t)) return null;
	const [keep, archives] = canonicalOrder(c.paths);
	const orderedContent = [keep, ...archives].map((p) => c.contents[c.paths.indexOf(p)]);
	const handles = await Promise.all(orderedContent.map((text) => caps.store.put(new TextEncoder().encode(text), "text/markdown")));
	const merged = await runReconcile({ mode: "faithful-union" }, handles, caps.store);
	const mergedContent = new TextDecoder().decode(await caps.store.get(merged));
	return { keep, archives, mergedContent, key: c.key };
}

/** Drop the non-actionable `null`s a per-cluster propose pass leaves behind. */
export function compactMergePlan(items: Array<MergePlanItem | null>): MergePlanItem[] {
	return items.filter((i): i is MergePlanItem => i !== null);
}
