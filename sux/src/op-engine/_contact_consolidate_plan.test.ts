import { describe, expect, it } from "vitest";
import { compactContactMergePlan, proposeContactMerge } from "./_contact_consolidate_plan";

describe("proposeContactMerge", () => {
	it("picks the lexicographically-first id as canonical regardless of input order", () => {
		const item = proposeContactMerge({ ids: ["b1", "a1"], names: ["Bob", "Bobby"], emails: [["b@x.com"], ["bob@x.com"]], phones: [[], []], companies: [undefined, undefined] });
		expect(item?.keep).toBe("a1");
		expect(item?.archives).toEqual(["b1"]);
	});

	it("unions every member's emails and phones, deduped and case/space-normalized", () => {
		const item = proposeContactMerge({
			ids: ["1", "2"],
			names: ["Ada", "Ada"],
			emails: [["ada@example.com"], ["ADA@Example.com ", "second@example.com"]],
			phones: [["555-1234"], ["555-1234", "555-5678"]],
			companies: [undefined, undefined],
		});
		expect(item?.emails.sort()).toEqual(["ada@example.com", "second@example.com"]);
		expect(item?.phones.sort()).toEqual(["555-1234", "555-5678"]);
	});

	it("dedups phones by normalized digits, not exact string match (#995)", () => {
		const item = proposeContactMerge({
			ids: ["1", "2"],
			names: ["Carol", "Carol J"],
			emails: [[], []],
			phones: [["+1 (555) 123-4567"], ["555-123-4567"]],
			companies: [undefined, undefined],
		});
		expect(item?.phones).toEqual(["+1 (555) 123-4567"]);
	});

	it("falls back to the longest non-empty name only when keep has none (#995)", () => {
		const item = proposeContactMerge({ ids: ["1", "2"], names: [undefined, "Colin Powell"], emails: [[], []], phones: [[], []], companies: [undefined, undefined] });
		expect(item?.name).toBe("Colin Powell");
	});

	it("prefers keep's own name over a longer duplicate's, so a merge never worsens the canonical card (#995)", () => {
		const item = proposeContactMerge({ ids: ["1", "2"], names: ["C. Powell", "Colin Powell (work)"], emails: [[], []], phones: [[], []], companies: [undefined, undefined] });
		expect(item?.name).toBe("C. Powell");
	});

	it("strips a stray parenthetical tag before it ever becomes the merged name, even on the fallback path (#995)", () => {
		const item = proposeContactMerge({ ids: ["1", "2"], names: [undefined, "Colin Powell (work)"], emails: [[], []], phones: [[], []], companies: [undefined, undefined] });
		expect(item?.name).toBe("Colin Powell");
	});

	it("keeps the first non-empty company", () => {
		const item = proposeContactMerge({ ids: ["1", "2"], names: [undefined, undefined], emails: [[], []], phones: [[], []], companies: [undefined, "Acme Inc"] });
		expect(item?.company).toBe("Acme Inc");
	});

	it("prefers keep's own company over an archived duplicate's (#995)", () => {
		const item = proposeContactMerge({ ids: ["1", "2"], names: [undefined, undefined], emails: [[], []], phones: [[], []], companies: ["Acme Inc", "Stale Co"] });
		expect(item?.company).toBe("Acme Inc");
	});

	it("composes a 3+ contact group into ONE cluster with a single keep and every other member as an archive", () => {
		const item = proposeContactMerge({
			ids: ["c3", "c1", "c2"],
			names: ["Dana", "D. West", "Dana West"],
			emails: [["d1@x.com"], ["d2@x.com"], []],
			phones: [[], [], ["555-0000"]],
			companies: [undefined, undefined, undefined],
		});
		expect(item?.keep).toBe("c1");
		expect(item?.archives.sort()).toEqual(["c2", "c3"]);
		expect(item?.emails.sort()).toEqual(["d1@x.com", "d2@x.com"]);
		expect(item?.phones).toEqual(["555-0000"]);
	});

	it("returns null for a cluster with fewer than 2 ids", () => {
		expect(proposeContactMerge({ ids: ["1"], names: [undefined], emails: [[]], phones: [[]], companies: [undefined] })).toBeNull();
	});

	it("returns null for a malformed cluster (mismatched parallel array lengths)", () => {
		expect(proposeContactMerge({ ids: ["1", "2"], names: [undefined], emails: [[], []], phones: [[], []], companies: [undefined, undefined] })).toBeNull();
	});
});

describe("compactContactMergePlan", () => {
	it("drops nulls and keeps order", () => {
		const a = { keep: "1", archives: ["2"], emails: [], phones: [] };
		expect(compactContactMergePlan([a, null, null])).toEqual([a]);
	});

	it("returns an empty array for an all-null batch", () => {
		expect(compactContactMergePlan([null, null])).toEqual([]);
	});
});
