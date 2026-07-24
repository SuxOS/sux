import { type Fn, fail, ok } from "../registry";
import { type FeedbackKind, resolveFeedback } from "./_feedback";
import { oj } from "./_util";

export const feedback_resolve: Fn = {
	name: "feedback_resolve",
	description:
		"Mark a server-side feedback log entry (GET /feedback, written by `issue`/`suggest`) as resolved/superseded — e.g. once it's been reconciled into a tracked GitHub issue — so it stops cluttering the default unresolved view. Never deletes the entry: GET /feedback?all=true still shows it, now with its resolution. Match by `at` — the entry's timestamp, as returned by GET /feedback (either the raw epoch-ms number or the ISO string GET /feedback prints both round-trip identically); pass `kind` too if two entries land on the same millisecond. `tracked_by` records where it now lives (a GitHub issue URL, a note path, …).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["at"],
		properties: {
			at: { type: ["number", "string"], description: "The entry's `at` field from GET /feedback (epoch ms or its ISO string — both resolve to the same entry)." },
			kind: { type: "string", enum: ["issue", "suggest"], description: "Optional: narrow the match when `at` alone is ambiguous." },
			tracked_by: { type: "string", description: "Optional: where this feedback is now tracked (e.g. a GitHub issue URL)." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const raw = args?.at;
		const at = typeof raw === "number" ? raw : Date.parse(String(raw ?? ""));
		if (!Number.isFinite(at)) return fail("Provide `at` — the entry's timestamp from GET /feedback (epoch ms or its ISO string).");
		const kind: FeedbackKind | undefined = args?.kind === "issue" || args?.kind === "suggest" ? args.kind : undefined;
		const tracked_by = typeof args?.tracked_by === "string" && args.tracked_by.trim() ? args.tracked_by.trim() : undefined;
		const resolvedCount = await resolveFeedback(env, at, { kind, tracked_by });
		if (!resolvedCount) return fail(`No unresolved feedback entry found at at=${at}${kind ? ` (kind=${kind})` : ""}.`);
		return ok(oj({ resolved: resolvedCount, at, ...(tracked_by ? { tracked_by } : {}) }));
	},
};
