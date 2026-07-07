import type { RtEnv } from "../registry";

export type FeedbackKind = "issue" | "suggest";
export type FeedbackEntry = { kind: FeedbackKind; text: string; at: number; tool?: string };

const KEY = "sux:feedback";
const CAP = 500;

function safeParse(s: string | null): FeedbackEntry[] {
	if (!s) return [];
	try {
		const v = JSON.parse(s);
		return Array.isArray(v) ? v : [];
	} catch {
		return [];
	}
}

export async function appendFeedback(env: RtEnv, kind: FeedbackKind, text: string, tool?: string): Promise<{ total: number; at: number }> {
	const items = safeParse(await env.OAUTH_KV.get(KEY));
	const at = Date.now();
	items.unshift({ kind, text, at, ...(tool ? { tool } : {}) });
	if (items.length > CAP) items.length = CAP;
	await env.OAUTH_KV.put(KEY, JSON.stringify(items));
	return { total: items.length, at };
}

export async function readFeedback(env: RtEnv, kind?: FeedbackKind, limit = 50, tool?: string): Promise<FeedbackEntry[]> {
	let items = safeParse(await env.OAUTH_KV.get(KEY));
	if (kind) items = items.filter((i) => i.kind === kind);
	if (tool) items = items.filter((i) => i.tool === tool);
	return items.slice(0, Math.max(0, limit));
}
