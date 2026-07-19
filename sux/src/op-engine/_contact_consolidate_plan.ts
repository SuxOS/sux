// Leaf logic for the `contacts-consolidate-plan` durable op (registry.ts): turns a batch of
// _contact_consolidate.ts-detected duplicate CANDIDATES (id + already-fetched name/emails/
// phones/company each side) into a batch of proposed, REVERSIBLE contact merges — nothing
// else. Deliberately non-destructive, mirroring _vault_consolidate_plan.ts's bar: the
// canonical card gets the union of every member's emails/phones (a `contact_update`), the
// other members are never contact_deleted, only tagged with a pointer back to the canonical
// (caps.ts's contactsMergeSink) — so a wrong merge judgment is always undoable by hand.
//
// Unlike vault-consolidate-plan's note bodies (unstructured text needing a faithful-union
// content merge via caps.store + suxlib's reconcile), a ContactCard's mergeable fields are
// already structured (arrays of emails/phones) — a plain set union needs no `caps` at all, so
// this stays a pure leaf.
import { normPhone, stripNameTags } from "../fns/_contact_consolidate.js";

export type ContactClusterInput = { ids: string[]; names: Array<string | undefined>; emails: string[][]; phones: string[][]; companies: Array<string | undefined> };
export type ContactMergePlanItem = { keep: string; archives: string[]; name?: string; company?: string; emails: string[]; phones: string[] };

/** Deterministic canonical pick: the lexicographically-first id always wins the "keep" slot —
 *  no external tie-break state needed, so replay (and two independent runs over the same
 *  group) always agree. Mirrors _vault_consolidate_plan.ts's canonicalOrder. */
function canonicalOrder(ids: string[]): [keep: string, archives: string[]] {
	const sorted = [...ids].sort();
	return [sorted[0], sorted.slice(1)];
}

/** Propose one cluster's merge: union every member's emails/phones (deduped, normalized).
 *  Prefers `keep`'s OWN name/company when it has one — a merge must never make the canonical
 *  card worse than before by overwriting a clean value with an archived duplicate's junk
 *  variant (e.g. a stray import-duplicate "Colin Powell (work)") — falling back to the
 *  longest/first non-empty value across the whole cluster only when `keep` has none (#995).
 *  Returns null for a malformed cluster (fewer than 2 ids, or a length mismatch across the
 *  parallel arrays) rather than throwing — one bad item must not sink the whole batch's `map`
 *  fan-out. */
export function proposeContactMerge(c: ContactClusterInput): ContactMergePlanItem | null {
	if (!c?.ids || c.ids.length < 2 || c.names.length !== c.ids.length || c.emails.length !== c.ids.length || c.phones.length !== c.ids.length || c.companies.length !== c.ids.length) return null;
	const [keep, archives] = canonicalOrder(c.ids);
	const keepIdx = c.ids.indexOf(keep);
	const emails = [...new Set(c.emails.flat().map((e) => e.trim().toLowerCase()).filter(Boolean))];
	// Dedup by the same normPhone() key _contact_consolidate.ts clustered on, not just an exact
	// trimmed-string match — "+15551234567" and "555-123-4567" cluster as the same number and
	// must collapse to one entry, keeping whichever formatted string was seen first.
	const phoneByKey = new Map<string, string>();
	for (const raw of c.phones.flat()) {
		const trimmed = raw.trim();
		const key = normPhone(trimmed);
		if (!key || phoneByKey.has(key)) continue;
		phoneByKey.set(key, trimmed);
	}
	const phones = [...phoneByKey.values()];
	const keepName = c.names[keepIdx] ? stripNameTags(c.names[keepIdx] as string) : undefined;
	const name = keepName || [...c.names].filter((n): n is string => !!n).map(stripNameTags).filter(Boolean).sort((a, b) => b.length - a.length)[0];
	const keepCompany = c.companies[keepIdx];
	const company = keepCompany || c.companies.find((co): co is string => !!co);
	return { keep, archives, ...(name ? { name } : {}), ...(company ? { company } : {}), emails, phones };
}

/** Drop the non-actionable `null`s a per-cluster propose pass leaves behind. */
export function compactContactMergePlan(items: Array<ContactMergePlanItem | null>): ContactMergePlanItem[] {
	return items.filter((i): i is ContactMergePlanItem => i !== null);
}
