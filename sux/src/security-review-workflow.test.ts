import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The security-review workflow is a requireable branch-protection gate, so its
// invariants must hold or the gate silently stops protecting `main`. This test guards
// them as plain text (no YAML dep): a regression here is a merge-blocking policy hole.
//
// This repo's security-review.yml is a THIN CALLER of the reusable
// SuxOS/.github/.github/workflows/security-review.yml (de-forked 2026-07 as part of the
// budget/cadence redesign — see SuxOS/.github docs/design/budget-and-cadence.md). The
// actual review logic (fail-closed blast-radius check, model, retries) lives and is
// tested in that reusable; this test only guards the caller's own contract.
const wf = (name: string) => readFileSync(join(process.cwd(), ".github/workflows", name), "utf8");

describe("security-review workflow is a real, requireable gate", () => {
	const sec = wf("security-review.yml");

	it("uses a DISTINCT job id so its check-run context doesn't collide with claude.yml's `review`", () => {
		expect(sec).toMatch(/^\s{2}security-review:/m);
		expect(sec).not.toMatch(/^\s{2}review:/m);
		// claude.yml is a thin caller of the reusable claude workflow, so its `review` job
		// surfaces as the check-run `claude / review` — namespaced under the caller job id,
		// it structurally cannot collide with the `security-review` check-run this gate uses.
		expect(wf("claude.yml")).toMatch(/uses:\s*SuxOS\/\.github\/\.github\/workflows\/claude\.yml@main/);
	});

	it("calls the org's reusable security-review workflow, not a forked copy", () => {
		expect(sec).toMatch(
			/uses:\s*SuxOS\/\.github\/\.github\/workflows\/security-review\.yml@main/,
		);
		// No local shell implementation of the review logic — that would silently drift
		// from the reusable's fail-closed blast-radius check (tested in SuxOS/.github).
		expect(sec).not.toMatch(/steps\.pre\.outputs\.go/);
	});

	it("triggers on the PR lifecycle AND merge_group (queue freezes forever without the latter)", () => {
		expect(sec).toMatch(/^\s*pull_request:\s*$/m);
		expect(sec).toMatch(/types:\s*\[opened,\s*synchronize,\s*reopened,\s*ready_for_review\]/);
		expect(sec).toMatch(/^\s*merge_group:\s*$/m);
	});

	it("grants only the permissions the reusable job needs", () => {
		expect(sec).toMatch(/contents:\s*read/);
		expect(sec).toMatch(/pull-requests:\s*write/);
		expect(sec).toMatch(/issues:\s*write/);
	});
});
