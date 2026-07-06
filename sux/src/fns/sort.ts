import { type Fn, fail, ok } from "../registry";

// Deterministic sort of text lines or a JSON array. Pure — no network.

/** Read a nested value at a dotted key path (a.b.c). Returns undefined if any hop is missing. */
function getPath(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (cur == null || typeof cur !== "object") return undefined;
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

/** Compare two values; numeric mode coerces to Number, else localeCompare on strings. */
function compare(a: unknown, b: unknown, numeric: boolean): number {
	if (numeric) {
		const na = Number(a);
		const nb = Number(b);
		const va = Number.isNaN(na) ? Number.POSITIVE_INFINITY : na;
		const vb = Number.isNaN(nb) ? Number.POSITIVE_INFINITY : nb;
		return va < vb ? -1 : va > vb ? 1 : 0;
	}
	return String(a ?? "").localeCompare(String(b ?? ""));
}

export const sort: Fn = {
	name: "sort",
	description:
		"Sort text lines or a JSON array. mode: lines (default) sorts newline-separated text; json sorts a JSON array — of scalars, or of objects by a `by` key (supports dotted a.b paths). order: asc (default) | desc. numeric (default false) compares as numbers. unique (default false) drops duplicates after sorting. Returns sorted text (lines) or a JSON array (json).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "Text (lines mode) or a JSON array string (json mode)." },
			mode: { type: "string", enum: ["lines", "json"], default: "lines", description: "How to interpret `data`." },
			by: { type: "string", description: "json mode: sort an array of objects by this key (dotted a.b path allowed)." },
			order: { type: "string", enum: ["asc", "desc"], default: "asc", description: "Sort direction." },
			numeric: { type: "boolean", default: false, description: "Compare values as numbers." },
			unique: { type: "boolean", default: false, description: "Remove duplicates after sorting." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		const mode = String(args?.mode ?? "lines");
		const order = args?.order === "desc" ? "desc" : "asc";
		const numeric = args?.numeric === true;
		const unique = args?.unique === true;
		const dir = order === "desc" ? -1 : 1;

		if (mode === "lines") {
			let lines = data === "" ? [] : data.split(/\r?\n/);
			lines = lines.slice().sort((a, b) => compare(a, b, numeric) * dir);
			if (unique) {
				const seen = new Set<string>();
				lines = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)));
			}
			return ok(lines.join("\n"));
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
			if (by) {
				for (const it of parsed) {
					if (it === null || typeof it !== "object" || Array.isArray(it)) {
						return fail(`\`by\` given but an array item is not an object (cannot read key '${by}').`);
					}
				}
			}
			const keyOf = (it: unknown) => (by ? getPath(it, by) : it);

			let out = parsed.slice().sort((a, b) => compare(keyOf(a), keyOf(b), numeric) * dir);
			if (unique) {
				const seen = new Set<string>();
				out = out.filter((it) => {
					const k = JSON.stringify(it);
					return seen.has(k) ? false : (seen.add(k), true);
				});
			}
			return ok(JSON.stringify(out, null, 2));
		}

		return fail("mode must be 'lines' or 'json'.");
	},
};
