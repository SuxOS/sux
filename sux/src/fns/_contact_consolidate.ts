// Duplicate-CONTACT detection — the missing half #965 documents: contact.ts already exposes
// full JMAP ContactCard CRUD, and contact_delete is already a STAGE_KINDS-gated verb, but
// nothing ever looked for duplicate cards (same email/phone, or a fuzzy name match like
// "Colin Powell" vs "C. Powell" vs a stray import-duplicate "Colin Powell (work)"). Unlike
// _consolidate.ts's duplicateKey (a single path-derived string key), a contact card has no one
// field that reliably identifies "the same person" — so this groups by ANY of three
// field-based signals (shared email, shared phone, or a fuzzy name match) via union-find, not
// a single key lookup. Crude but cheap on purpose: every cluster this produces is only ever a
// PROPOSAL a human approves or rejects (contact_consolidate_plan.ts's durable run), never
// auto-applied — so, mirroring _consolidate.ts's duplicateKey, this favors recall over
// precision.
import type { RtEnv } from "../registry";

// A truthy toggle ("0"/"false"/"off"/empty ⇒ off) — mirrors _consolidate.ts/_cross_semantic.ts's
// flagOn, so an explicit CONTACT_CONSOLIDATE_ENABLED=0 stays off rather than arming on mere presence.
const flagOn = (v: string | undefined): boolean => {
	const s = String(v ?? "").trim().toLowerCase();
	return s !== "" && s !== "0" && s !== "false" && s !== "no" && s !== "off";
};

/** The contact-consolidation sweep may run at all. Unset ⇒ the feature is dormant (no-op). */
export const hasContactConsolidate = (env: RtEnv): boolean => flagOn(env.CONTACT_CONSOLIDATE_ENABLED);

/** Trimmed to what dedup detection needs — matches contact_search's shapeContact() reference shape. */
export type ContactRef = { id: string; name?: string; emails?: string[]; phones?: string[] };
export type DuplicateContactCluster = { ids: string[] };

const normEmail = (e: string): string => e.trim().toLowerCase();

/** Digits only, US country-code (leading "1" on 11 digits) stripped so "+1 (555) 123-4567" and
 *  "555-123-4567" collapse to the same key. Shorter than 7 digits is too weak a signal (a
 *  stray extension-only number) to treat as a match — left out of the phone index entirely. */
const normPhone = (p: string): string => p.replace(/\D/g, "").replace(/^1(\d{10})$/, "$1");

/** Lowercased, parenthetical tags ("(work)", "(home)") and punctuation stripped, whitespace
 *  collapsed — "Colin Powell (work)" and "colin  powell" both become "colin powell". */
const normName = (name?: string): string =>
	(name ?? "")
		.toLowerCase()
		.replace(/\([^)]*\)/g, "")
		.replace(/[^a-z\s]/g, "")
		.replace(/\s+/g, " ")
		.trim();

/** Two normalized names are a fuzzy match when they share a last name (the final word) and
 *  either the first word matches exactly or one side is a single-letter initial of the
 *  other's ("colin powell" / "c powell" both match "powell" + c===c). */
function namesMatch(a: string, b: string): boolean {
	if (!a || !b) return false;
	if (a === b) return true;
	const wa = a.split(" ").filter(Boolean);
	const wb = b.split(" ").filter(Boolean);
	if (wa.length < 1 || wb.length < 1) return false;
	if (wa[wa.length - 1] !== wb[wb.length - 1]) return false;
	const [fa, fb] = [wa[0], wb[0]];
	if (fa === fb) return true;
	return (fa.length === 1 || fb.length === 1) && fa[0] === fb[0];
}

/** Union-find over one page of contacts (contact_search's own 100-per-call cap bounds the
 *  input size, so the O(n²) name-fuzzing pass below stays cheap): two contacts land in the
 *  same cluster when they share a normalized email, a normalized phone, or a fuzzy-matching
 *  name. Singleton groups (nothing else in the page matched) are dropped — only real
 *  candidate clusters of 2+ come back. */
export function findDuplicateContacts(contacts: ContactRef[]): DuplicateContactCluster[] {
	const n = contacts.length;
	const parent = Array.from({ length: n }, (_, i) => i);
	const find = (i: number): number => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const union = (a: number, b: number): void => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	};

	const byEmail = new Map<string, number[]>();
	const byPhone = new Map<string, number[]>();
	const names = contacts.map((c) => normName(c.name));
	contacts.forEach((c, i) => {
		for (const e of c.emails ?? []) {
			const k = normEmail(e);
			if (!k) continue;
			const list = byEmail.get(k) ?? [];
			list.push(i);
			byEmail.set(k, list);
		}
		for (const p of c.phones ?? []) {
			const k = normPhone(p);
			if (k.length < 7) continue;
			const list = byPhone.get(k) ?? [];
			list.push(i);
			byPhone.set(k, list);
		}
	});
	for (const idxs of byEmail.values()) for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
	for (const idxs of byPhone.values()) for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
	for (let i = 0; i < n; i++) {
		if (!names[i]) continue;
		for (let j = i + 1; j < n; j++) {
			if (!names[j]) continue;
			if (namesMatch(names[i], names[j])) union(i, j);
		}
	}

	const groups = new Map<number, number[]>();
	for (let i = 0; i < n; i++) {
		const r = find(i);
		const list = groups.get(r) ?? [];
		list.push(i);
		groups.set(r, list);
	}
	const clusters: DuplicateContactCluster[] = [];
	for (const idxs of groups.values()) {
		if (idxs.length < 2) continue;
		clusters.push({ ids: idxs.map((i) => contacts[i].id) });
	}
	return clusters;
}
