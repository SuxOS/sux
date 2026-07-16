import { type Fn, fail, ok } from "../registry";
import { fetchTextOkEscalating, oj } from "./_util";

// ReDoS guard: true when `pattern` contains a group (capturing, non-capturing, or
// lookaround — anything delimited by balanced parens) that's immediately followed by
// a quantifier (+, *, {n,}) and whose own content contains a quantifier or alternation
// character ANYWHERE within its true balanced span — not just before the first `)`.
// A naive single-level check like `\([^)]*[+*{|][^)]*\)\s*[+*{]` cannot see past an
// inner group's own closing paren, so a dangerous quantifier nested one (or more)
// levels deep — e.g. `((a+)(a*))+` — sails through untouched: the `[^)]*` segments
// always hit the FIRST `)` (the inner group's) before ever reaching the outer one.
// This walks the pattern once, tracking escapes (`\(` is a literal paren, not a group
// delimiter) and character classes (`[()]` — parens inside `[...]` are literal too),
// so each group's span is its TRUE matching close paren regardless of nesting depth.
function hasNestedCatastrophicQuantifier(pattern: string): boolean {
	const opens: number[] = [];
	let inClass = false;
	for (let i = 0; i < pattern.length; i++) {
		const c = pattern[i];
		if (c === "\\") {
			i++; // skip the escaped character entirely — it can't open/close a group or class
			continue;
		}
		if (inClass) {
			if (c === "]") inClass = false;
			continue;
		}
		if (c === "[") {
			inClass = true;
			continue;
		}
		if (c === "(") {
			opens.push(i);
			continue;
		}
		if (c === ")") {
			const start = opens.pop();
			if (start === undefined) continue; // unmatched — let new RegExp() reject it below
			const followedByQuantifier = /^\s*[+*{]/.test(pattern.slice(i + 1));
			if (followedByQuantifier && /[+*{|]/.test(pattern.slice(start + 1, i))) return true;
		}
	}
	return false;
}

export const grep: Fn = {
	name: "grep",
	description:
		"Regex search over text, line by line. Provide a `pattern` plus either raw `text` or a `url` (fetched via residential proxy first). ignore_case (default false) adds the 'i' flag. context (default 0) includes N lines before and after each match. max (default 200) caps returned matches. Returns JSON { count, matches:[{ line, text, context? }] }; invalid regex fails with the error.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["pattern"],
		properties: {
			pattern: { type: "string", description: "JavaScript regular expression." },
			text: { type: "string", description: "Text to search (used instead of fetching `url`)." },
			url: { type: "string", description: "Absolute http(s) URL to fetch and search." },
			ignore_case: { type: "boolean", default: false, description: "Case-insensitive matching." },
			context: { type: "integer", default: 0, minimum: 0, maximum: 20, description: "Lines of surrounding context per match." },
			max: { type: "integer", default: 200, minimum: 1, maximum: 5000, description: "Max matches to return." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		const pattern = String(args?.pattern ?? "");
		if (!pattern) return fail("Provide a regex `pattern`.");
		// ReDoS guardrails: cap the pattern size and reject the classic
		// catastrophic-backtracking shapes — an outer quantifier (+, *, {n,})
		// applied to a group whose body already contains a quantifier ((a+)+,
		// (a*)*, (.*)+, (a{2,})+ …) or a top-level alternation ((a|aa)+ …),
		// at ANY nesting depth (see hasNestedCatastrophicQuantifier above —
		// e.g. `((a+)(a*))+`). Both make matching backtrack exponentially.
		// Heuristic, not exhaustive; grep is OAuth-gated so this bounds
		// self-inflicted stalls, and a rejected pattern can be rewritten
		// without an outer quantifier over such a group.
		if (pattern.length > 1000) return fail("Pattern too long (max 1000 chars).");
		if (hasNestedCatastrophicQuantifier(pattern)) {
			return fail("Pattern rejected: an outer quantifier over a group that itself contains a quantifier or alternation ((x+)+, (x*)*, (.*)+, (x{2,})+, (a|aa)+ …), at any nesting depth, risks catastrophic backtracking. Rewrite without a quantifier applied to such a group.");
		}

		let re: RegExp;
		try {
			re = new RegExp(pattern, args?.ignore_case === true ? "i" : "");
		} catch (e) {
			return fail(`Invalid regex: ${String((e as Error).message ?? e)}`);
		}

		let text = typeof args?.text === "string" ? args.text : "";
		if (!text && args?.url) {
			const fetched = await fetchTextOkEscalating(env, args.url);
			if ("error" in fetched) return fail(fetched.error);
			text = fetched.text;
		}
		if (!text) return fail("Provide `text` or `url`.");

		const context = Math.min(Number(args?.context) || 0, 20);
		const max = Math.min(5000, Math.max(1, Number(args?.max) || 200));
		const lines = text.split(/\r?\n/);

		const matches: Array<{ line: number; text: string; context?: string[] }> = [];
		let total = 0;
		for (let i = 0; i < lines.length; i++) {
			if (!re.test(lines[i])) continue;
			total++;
			if (matches.length >= max) continue;
			const hit: { line: number; text: string; context?: string[] } = { line: i + 1, text: lines[i] };
			if (context > 0) {
				hit.context = lines.slice(Math.max(0, i - context), Math.min(lines.length, i + context + 1));
			}
			matches.push(hit);
		}

		return ok(oj({ count: total, matches }));
	},
};
