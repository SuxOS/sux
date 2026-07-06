import { type Fn, fail, ok } from "../registry";

/** True for a plain object or array (the containers we recurse into). */
function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
	return v !== null && typeof v === "object";
}

/** Flatten nested containers into a single-level map of `path -> leaf`. */
function flatten(value: unknown, sep: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const recurse = (node: unknown, prefix: string) => {
		if (Array.isArray(node)) {
			if (node.length === 0) {
				if (prefix) out[prefix] = [];
				return;
			}
			node.forEach((el, i) => recurse(el, prefix ? `${prefix}${sep}${i}` : String(i)));
		} else if (isContainer(node)) {
			const keys = Object.keys(node);
			if (keys.length === 0) {
				if (prefix) out[prefix] = {};
				return;
			}
			for (const k of keys) recurse((node as Record<string, unknown>)[k], prefix ? `${prefix}${sep}${k}` : k);
		} else {
			out[prefix] = node;
		}
	};
	recurse(value, "");
	return out;
}

/** Rebuild nested containers from a flat `path -> leaf` map (inverse of `flatten`). */
function unflatten(flat: Record<string, unknown>, sep: string): unknown {
	const root: Record<string, unknown> = {};
	for (const path of Object.keys(flat)) {
		const parts = path.split(sep);
		let node: Record<string, unknown> = root;
		for (let i = 0; i < parts.length - 1; i++) {
			const key = parts[i];
			if (!isContainer(node[key])) node[key] = {};
			node = node[key] as Record<string, unknown>;
		}
		node[parts[parts.length - 1]] = flat[path];
	}
	// Collapse objects whose keys are exactly 0..n-1 into arrays.
	const arrayify = (v: unknown): unknown => {
		if (!isContainer(v) || Array.isArray(v)) return v;
		const obj = v as Record<string, unknown>;
		const keys = Object.keys(obj);
		for (const k of keys) obj[k] = arrayify(obj[k]);
		const isArrayShape = keys.length > 0 && keys.every((k) => /^\d+$/.test(k));
		if (!isArrayShape) return obj;
		const indices = keys.map(Number).sort((a, b) => a - b);
		if (indices[0] !== 0 || indices[indices.length - 1] !== indices.length - 1) return obj;
		return indices.map((i) => obj[String(i)]);
	};
	return arrayify(root);
}

export const flattenFn: Fn = {
	name: "flatten",
	description:
		"Flatten or unflatten nested JSON. direction: flatten (default) turns a nested object/array into a single-level map of joined paths (`{\"a.b.0\": v}`); unflatten inverts it, reviving arrays from consecutive 0-based integer keys. sep (default `.`) is the path separator. Returns pretty JSON. Fails on invalid JSON.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "The JSON document as a string." },
			direction: { type: "string", enum: ["flatten", "unflatten"], default: "flatten", description: "flatten a nested doc, or unflatten a flat path map." },
			sep: { type: "string", default: ".", description: "Path separator joining keys/indices." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const raw = String(args?.data ?? "");
		if (!raw.trim()) return fail("Provide `data` (a JSON string).");
		const direction = String(args?.direction ?? "flatten");
		if (direction !== "flatten" && direction !== "unflatten") return fail("direction must be 'flatten' or 'unflatten'.");
		const sep = args?.sep != null ? String(args.sep) : ".";
		if (!sep) return fail("sep must be a non-empty string.");

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			return fail(`data is not valid JSON: ${String((e as Error).message ?? e)}`);
		}

		if (direction === "flatten") {
			return ok(JSON.stringify(flatten(parsed, sep), null, 2));
		}
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return fail("unflatten expects `data` to be a flat JSON object of path -> value.");
		}
		return ok(JSON.stringify(unflatten(parsed as Record<string, unknown>, sep), null, 2));
	},
};
