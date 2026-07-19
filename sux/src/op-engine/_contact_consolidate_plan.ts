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
export type ContactClusterInput = { ids: string[]; names: Array<string | undefined>; emails: string[][]; phones: string[][]; companies: Array<string | undefined> };
export type ContactMergePlanItem = { keep: string; archives: string[]; name?: string; company?: string; emails: string[]; phones: string[] };

/** Deterministic canonical pick: the lexicographically-first id always wins the "keep" slot —
 *  no external tie-break state needed, so replay (and two independent runs over the same
 *  group) always agree. Mirrors _vault_consolidate_plan.ts's canonicalOrder. */
function canonicalOrder(ids: string[]): [keep: string, archives: string[]] {
	const sorted = [...ids].sort();
	return [sorted[0], sorted.slice(1)];
}

/** Propose one cluster's merge: union every member's emails/phones (deduped, normalized), keep
 *  the longest non-empty name (the most complete variant — "Colin Powell" over "C. Powell")
 *  and the first non-empty company. Returns null for a malformed cluster (fewer than 2 ids, or
 *  a length mismatch across the parallel arrays) rather than throwing — one bad item must not
 *  sink the whole batch's `map` fan-out. */
export function proposeContactMerge(c: ContactClusterInput): ContactMergePlanItem | null {
	if (!c?.ids || c.ids.length < 2 || c.names.length !== c.ids.length || c.emails.length !== c.ids.length || c.phones.length !== c.ids.length || c.companies.length !== c.ids.length) return null;
	const [keep, archives] = canonicalOrder(c.ids);
	const emails = [...new Set(c.emails.flat().map((e) => e.trim().toLowerCase()).filter(Boolean))];
	const phones = [...new Set(c.phones.flat().map((p) => p.trim()).filter(Boolean))];
	const name = [...c.names].filter((n): n is string => !!n).sort((a, b) => b.length - a.length)[0];
	const company = c.companies.find((co): co is string => !!co);
	return { keep, archives, ...(name ? { name } : {}), ...(company ? { company } : {}), emails, phones };
}

/** Drop the non-actionable `null`s a per-cluster propose pass leaves behind. */
export function compactContactMergePlan(items: Array<ContactMergePlanItem | null>): ContactMergePlanItem[] {
	return items.filter((i): i is ContactMergePlanItem => i !== null);
}
