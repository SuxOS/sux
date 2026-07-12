import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUX_SKILL_DESCRIPTION, SUX_SKILL_PROMPT } from "./skill-prompt";

// The embed is committed (a Worker has no runtime FS); this test is the drift gate
// — no CI workflow step needed. It re-derives the prompt from SKILL.md the same way
// gen-skill-prompt.mjs does and asserts the checked-in constant matches, so a
// SKILL.md edit that wasn't regenerated (`npm run gen:skill`) fails `npm test`.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILL = join(ROOT, ".claude", "skills", "sux", "SKILL.md");

describe("skill-prompt embed", () => {
	it("matches the current SKILL.md (regenerate with `npm run gen:skill`)", () => {
		const raw = readFileSync(SKILL, "utf8");
		const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
		const body = (m ? m[2] : raw).trim();
		const description = (m?.[1].match(/^description:\s*(.*)$/m)?.[1] ?? "sux edge-function routing guidance").trim();
		expect(SUX_SKILL_PROMPT).toBe(body);
		expect(SUX_SKILL_DESCRIPTION).toBe(description);
	});

	it("is non-empty and starts at the SKILL heading", () => {
		expect(SUX_SKILL_PROMPT.startsWith("# sux")).toBe(true);
		expect(SUX_SKILL_PROMPT).toContain("edge function engine");
	});
});
