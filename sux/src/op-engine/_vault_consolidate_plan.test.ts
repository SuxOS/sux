import { describe, expect, it } from "vitest";
import { MemoryStore, type Caps } from "@suxos/lib";
import { compactMergePlan, proposeMerge } from "./_vault_consolidate_plan";

const caps = { store: new MemoryStore(), llm: {}, clock: { now: () => 0 }, sinks: {} } as unknown as Caps;

describe("proposeMerge", () => {
	it("picks the lexicographically-first path as canonical regardless of input order", async () => {
		const item = await proposeMerge({ paths: ["Archive/Project Alpha (2).md", "Projects/project-alpha.md"], contents: ["alpha body", "alpha body plus more"], key: "project alpha" }, caps);
		expect(item?.keep).toBe("Archive/Project Alpha (2).md" < "Projects/project-alpha.md" ? "Archive/Project Alpha (2).md" : "Projects/project-alpha.md");
		expect(item?.archives).not.toContain(item?.keep);
	});

	it("agrees on keep/archives no matter which order the group's paths land in", async () => {
		const forward = await proposeMerge({ paths: ["A.md", "B.md"], contents: ["x", "y"], key: "k" }, caps);
		const backward = await proposeMerge({ paths: ["B.md", "A.md"], contents: ["y", "x"], key: "k" }, caps);
		expect(forward?.keep).toBe("A.md");
		expect(forward?.archives).toEqual(["B.md"]);
		expect(backward?.keep).toBe(forward?.keep);
		expect(backward?.archives).toEqual(forward?.archives);
	});

	it("faithful-unions every member's content into one mergedContent, deduping identical bodies", async () => {
		const item = await proposeMerge({ paths: ["A.md", "B.md"], contents: ["same body", "same body"], key: "k" }, caps);
		// faithful-union collapses identical content blocks to one copy, tagged with its source handle.
		expect(item?.mergedContent).toContain("same body");
		expect(item?.mergedContent?.match(/same body/g)).toHaveLength(1);
	});

	it("composes a 3+ note group into ONE cluster with a single keep and every other member as an archive", async () => {
		const item = await proposeMerge({ paths: ["Project (2).md", "Project.md", "Project (1).md"], contents: ["c2", "c0", "c1"], key: "project" }, caps);
		expect(item?.keep).toBe("Project (1).md");
		expect(item?.archives.sort()).toEqual(["Project (2).md", "Project.md"].sort());
		expect(item?.mergedContent).toContain("c0");
		expect(item?.mergedContent).toContain("c1");
		expect(item?.mergedContent).toContain("c2");
	});

	it("returns null for a malformed cluster (missing content)", async () => {
		expect(await proposeMerge({ paths: ["A.md", "B.md"], contents: ["", "y"], key: "k" }, caps)).toBeNull();
	});

	it("returns null for a cluster with fewer than 2 paths", async () => {
		expect(await proposeMerge({ paths: ["A.md"], contents: ["x"], key: "k" }, caps)).toBeNull();
	});
});

describe("compactMergePlan", () => {
	it("drops nulls and keeps order", () => {
		const a = { keep: "A.md", archives: ["B.md"], mergedContent: "x", key: "k" };
		expect(compactMergePlan([a, null, null])).toEqual([a]);
	});

	it("returns an empty array for an all-null batch", () => {
		expect(compactMergePlan([null, null])).toEqual([]);
	});
});
