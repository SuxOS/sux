import { type Fn, fail, ok } from "../registry";

type Step = { type: "key"; key: string } | { type: "index"; idx: number } | { type: "wild" };

/** Parse a dotted path like `a.b[0].c` or `items[*].name` (optional leading `$`) into steps. */
function parsePath(path: string): Step[] {
	let p = path.trim();
	if (p.startsWith("$")) p = p.slice(1);
	if (p.startsWith(".")) p = p.slice(1);
	const steps: Step[] = [];
	let i = 0;
	const n = p.length;
	while (i < n) {
		const ch = p[i];
		if (ch === ".") {
			i++;
			continue;
		}
		if (ch === "[") {
			const close = p.indexOf("]", i);
			if (close === -1) throw new Error(`unclosed '[' at position ${i}`);
			const inner = p.slice(i + 1, close).trim();
			if (inner === "*") steps.push({ type: "wild" });
			else {
				const idx = Number(inner);
				if (!Number.isInteger(idx) || idx < 0) throw new Error(`bad array index '${inner}' — use [n] or [*]`);
				steps.push({ type: "index", idx });
			}
			i = close + 1;
			continue;
		}
		// Bare key: read until the next '.' or '['.
		let j = i;
		while (j < n && p[j] !== "." && p[j] !== "[") j++;
		const key = p.slice(i, j);
		if (!key) throw new Error(`empty key near position ${i}`);
		steps.push({ type: "key", key });
		i = j;
	}
	return steps;
}

/**
 * Walk `root` through `steps`. A `wild` step maps over the current array and the
 * remaining steps are applied to each element (jq-style `[]`), so the result is
 * flattened into an array. Throws on a missing key or out-of-range / type mismatch.
 */
function walk(value: unknown, steps: Step[], at: number, trail: string): unknown {
	if (at >= steps.length) return value;
	const step = steps[at];
	if (step.type === "wild") {
		if (!Array.isArray(value)) throw new Error(`'${trail}' is not an array (cannot apply [*])`);
		return value.map((el, k) => walk(el, steps, at + 1, `${trail}[${k}]`));
	}
	if (step.type === "index") {
		if (!Array.isArray(value)) throw new Error(`'${trail}' is not an array (cannot index [${step.idx}])`);
		if (step.idx >= value.length) throw new Error(`index [${step.idx}] out of range at '${trail}' (length ${value.length})`);
		return walk(value[step.idx], steps, at + 1, `${trail}[${step.idx}]`);
	}
	// key
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`'${trail}' is not an object (cannot read key '${step.key}')`);
	}
	if (!Object.prototype.hasOwnProperty.call(value, step.key)) {
		throw new Error(`key '${step.key}' not found at '${trail || "$"}'`);
	}
	return walk((value as Record<string, unknown>)[step.key], steps, at + 1, trail ? `${trail}.${step.key}` : step.key);
}

export const json_query: Fn = {
	name: "json_query",
	description:
		"Query a JSON document with a dotted path (jq-lite, no dependencies). path supports dot keys (`a.b`), array index (`[n]`), wildcard-map over an array (`[*]`, jq-style — returns an array of the sub-selection), and an optional leading `$`. Examples: `a.b[0].c`, `items[*].name`. Returns the selected value(s) as pretty JSON. Fails on a parse error, missing key, or out-of-range index.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data", "path"],
		properties: {
			data: { type: "string", description: "The JSON document as a string." },
			path: { type: "string", description: "Dotted path, e.g. `items[*].name` or `$.a.b[0]`." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const raw = String(args?.data ?? "");
		const path = String(args?.path ?? "").trim();
		if (!raw) return fail("Provide `data` (a JSON string).");
		if (!path) return fail("Provide `path` (e.g. `a.b[0].c`).");
		let root: unknown;
		try {
			root = JSON.parse(raw);
		} catch (e) {
			return fail(`data is not valid JSON: ${String((e as Error).message ?? e)}`);
		}
		let steps: Step[];
		try {
			steps = parsePath(path);
		} catch (e) {
			return fail(`bad path: ${String((e as Error).message ?? e)}`);
		}
		try {
			const result = walk(root, steps, 0, "");
			return ok(JSON.stringify(result, null, 2));
		} catch (e) {
			return fail(String((e as Error).message ?? e));
		}
	},
};
