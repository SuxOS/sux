import { type Fn, fail, ok } from "../registry";

/** Stable key for a JSON value: deep-sorted so key order never affects identity. */
function stableKey(v: unknown): string {
	return JSON.stringify(sortValue(v));
}
function sortValue(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(sortValue);
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sortValue((v as Record<string, unknown>)[k]);
		return out;
	}
	return v;
}

/** Deduplicate `items`, keeping the first or last occurrence, preserving input order of kept items. */
function dedupeBy<T>(items: T[], keyOf: (item: T) => string, keep: "first" | "last"): { kept: T[]; removed: number } {
	if (keep === "first") {
		const seen = new Set<string>();
		const kept: T[] = [];
		for (const it of items) {
			const k = keyOf(it);
			if (seen.has(k)) continue;
			seen.add(k);
			kept.push(it);
		}
		return { kept, removed: items.length - kept.length };
	}
	// keep last: last write wins, but emit in first-seen positional order.
	const lastIndex = new Map<string, number>();
	items.forEach((it, i) => lastIndex.set(keyOf(it), i));
	const emittedAt = new Set<number>();
	const kept: T[] = [];
	items.forEach((it, i) => {
		const k = keyOf(it);
		const li = lastIndex.get(k)!;
		if (emittedAt.has(li)) return;
		emittedAt.add(li);
		kept.push(items[li]);
	});
	return { kept, removed: items.length - kept.length };
}

export const dedupe: Fn = {
	name: "dedupe",
	description:
		"Deduplicate data while preserving order. mode: lines (default) dedupes text lines; json dedupes a JSON array — by whole-item value (deep, key-order-insensitive) or by a single `by` key when items are objects. keep: first (default) | last chooses which occurrence survives. Returns { kept, removed, result } where result is the deduped text (lines) or JSON array (json).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "Text (lines mode) or a JSON array string (json mode)." },
			mode: { type: "string", enum: ["lines", "json"], default: "lines", description: "How to interpret `data`." },
			by: { type: "string", description: "json mode only: dedupe an array of objects by this key instead of the whole item." },
			keep: { type: "string", enum: ["first", "last"], default: "first", description: "Which duplicate occurrence to keep." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		const mode = String(args?.mode ?? "lines");
		const keep = args?.keep === "last" ? "last" : "first";

		if (mode === "lines") {
			const lines = data.split(/\r?\n/);
			const { kept, removed } = dedupeBy(lines, (l) => l, keep);
			return ok(JSON.stringify({ kept: kept.length, removed, result: kept.join("\n") }, null, 2));
		}

		if (mode === "json") {
			let parsed: unknown;
			try {
				parsed = JSON.parse(data);
			} catch (e) {
				return fail(`data is not valid JSON: ${String((e as Error).message ?? e)}`);
			}
			if (!Array.isArray(parsed)) return fail("json mode expects `data` to be a JSON array.");
			const by = args?.by != null ? String(args.by) : "";
			let keyOf: (item: unknown) => string;
			if (by) {
				for (const it of parsed) {
					if (it === null || typeof it !== "object" || Array.isArray(it)) {
						return fail(`\`by\` given but an array item is not an object (cannot read key '${by}').`);
					}
				}
				keyOf = (it) => stableKey((it as Record<string, unknown>)[by]);
			} else {
				keyOf = (it) => stableKey(it);
			}
			const { kept, removed } = dedupeBy(parsed, keyOf, keep);
			return ok(JSON.stringify({ kept: kept.length, removed, result: kept }, null, 2));
		}

		return fail("mode must be 'lines' or 'json'.");
	},
};
