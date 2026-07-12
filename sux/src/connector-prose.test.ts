import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

// Guards against a recurring drift: docs re-asserting that the vault/mail/files
// namespaces were "retired into the single /mcp front door" as verbs on one
// connector. They weren't — connectors.ts keeps them as separate, OAuth-authorized
// /<domain>/mcp connectors that are merely unadvertised (advertised:false, ?all=1
// to opt in). Any of these phrases means a doc has slipped back to the false shape.
// docs/proposals/ is exempt: those are point-in-time records allowed their own
// (superseded) historical framing.
const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(dirname(SELF))) + "/";

const FORBIDDEN = [
	"retired into the single /mcp",
	"same sux connector",
	"on the one sux-router connector",
	"collapsed onto one connector",
	"collapsed onto the one connector",
	"verbs on the one /mcp connector",
	"front-door verb families on it",
	"all live behind that single front door",
];

const SKIP_DIRS = new Set(["node_modules", ".git", ".claude/worktrees", "dist", "coverage", "docs/proposals"]);
const EXTS = [".md", ".txt", ".json", ".jsonc", ".ts"];

function walk(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		const relPath = p.slice(ROOT.length);
		if (SKIP_DIRS.has(relPath) || relPath.includes("/.git/") || relPath.includes("node_modules/")) continue;
		const s = statSync(p);
		if (s.isDirectory()) walk(p, out);
		else if (p !== SELF && EXTS.some((e) => p.endsWith(e))) out.push(p);
	}
	return out;
}

describe("connector-surface prose", () => {
	it("no doc claims vault/mail/files were merged into the one /mcp connector", () => {
		const offenders: string[] = [];
		for (const file of walk(ROOT)) {
			// Backtick-agnostic: `/mcp` and /mcp should both trip the guard.
			const text = readFileSync(file, "utf8").toLowerCase().replaceAll("`", "");
			for (const phrase of FORBIDDEN) {
				if (text.includes(phrase)) offenders.push(`${file.slice(ROOT.length)} :: "${phrase}"`);
			}
		}
		expect(offenders, `stale one-connector framing (see docs/wiki/concepts/connector-surface-policy.md):\n${offenders.join("\n")}`).toEqual([]);
	});
});
