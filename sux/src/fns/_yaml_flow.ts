// Workaround for @suxos/lib's parseYaml (a separate, read-only-here repo — see
// CLAUDE.md's suxlib gotchas): its parseScalar only recovers a flow-style
// collection (`[x, y]` / `{a: 1}`) via a bare JSON.parse, which fails (and
// silently falls through to the raw string) for anything not already valid
// JSON — e.g. unquoted bareword elements. This re-parses those leftover
// strings using YAML's own (looser) scalar rules, recursively, so nested
// flow collections resolve too. Fixed upstream, this becomes a no-op and can
// be dropped (#1399).

function parseFlowScalar(raw: string): unknown {
	const s = raw.trim();
	if (s === "" || s === "~" || s === "null") return null;
	if (s === "true") return true;
	if (s === "false") return false;
	if (/^-?(0|[1-9]\d*)$/.test(s)) {
		const n = parseInt(s, 10);
		if (Number.isSafeInteger(n)) return n;
	}
	if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
	if (/^-?\d(\.\d+)?[eE][+-]?\d+$/.test(s)) return parseFloat(s);
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		if (s[0] === '"') {
			try {
				return JSON.parse(s);
			} catch {
				return s.slice(1, -1);
			}
		}
		return s.slice(1, -1).replace(/''/g, "'");
	}
	if (s.startsWith("[") || s.startsWith("{")) {
		const parsed = parseFlowCollection(s);
		if (parsed !== undefined) return parsed;
	}
	return s;
}

// Splits a flow collection's inner content on top-level commas, respecting
// nested brackets/braces and quotes so `[a, [b, c]]`/`{k: "a, b"}` split correctly.
function splitFlowItems(inner: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let quote: string | null = null;
	let start = 0;
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (quote) {
			if (c === "\\" && quote === '"') i++;
			else if (c === quote) quote = null;
			continue;
		}
		if (c === '"' || c === "'") quote = c;
		else if (c === "[" || c === "{") depth++;
		else if (c === "]" || c === "}") depth--;
		else if (c === "," && depth === 0) {
			items.push(inner.slice(start, i));
			start = i + 1;
		}
	}
	const last = inner.slice(start);
	if (last.trim() !== "" || items.length > 0) items.push(last);
	return items;
}

function parseFlowCollection(s: string): unknown {
	if (s.startsWith("[") && s.endsWith("]")) {
		const inner = s.slice(1, -1).trim();
		if (inner === "") return [];
		return splitFlowItems(inner).map((item) => parseFlowScalar(item.trim()));
	}
	if (s.startsWith("{") && s.endsWith("}")) {
		const inner = s.slice(1, -1).trim();
		if (inner === "") return {};
		const out: Record<string, unknown> = {};
		for (const item of splitFlowItems(inner)) {
			const idx = item.indexOf(":");
			if (idx === -1) return undefined; // not a valid flow mapping entry — bail, leave the original string alone
			const key = parseFlowScalar(item.slice(0, idx).trim());
			const val = parseFlowScalar(item.slice(idx + 1).trim());
			out[String(key)] = val;
		}
		return out;
	}
	return undefined;
}

/** Looks like an unresolved YAML flow collection left as a literal string by
 * suxlib's parseScalar (starts/ends with matching brackets, at least one
 * comma or colon inside — so a plain string that merely starts with "[" isn't
 * mistaken for one). */
function looksLikeUnresolvedFlow(s: string): boolean {
	return (s.startsWith("[") && s.endsWith("]") && s.length > 2) || (s.startsWith("{") && s.endsWith("}") && s.length > 2);
}

/** Recursively walks a parsed YAML value and resolves any leftover flow-style
 * strings (`"[x, y]"`, `"{a: 1}"`) that suxlib's parser couldn't already parse
 * as valid JSON. Values that don't parse as a flow collection are left as-is. */
export function fixYamlFlowStrings(value: unknown): unknown {
	if (typeof value === "string") {
		if (!looksLikeUnresolvedFlow(value)) return value;
		const parsed = parseFlowCollection(value);
		return parsed === undefined ? value : fixYamlFlowStrings(parsed);
	}
	if (Array.isArray(value)) return value.map(fixYamlFlowStrings);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = fixYamlFlowStrings(v);
		return out;
	}
	return value;
}
