import { describe, expect, it } from "vitest";
import { computeCrossSemanticCandidates, hasCrossSemantic } from "./_cross_semantic";

describe("hasCrossSemantic", () => {
	it("is off unless CROSS_SEMANTIC_ENABLED is truthy, and an explicit falsey value stays off", () => {
		expect(hasCrossSemantic({} as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "0" } as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "false" } as any)).toBe(false);
		expect(hasCrossSemantic({ CROSS_SEMANTIC_ENABLED: "1" } as any)).toBe(true);
	});
});

// Two orthogonal 4-dim "topics" so cosine similarity is exact and easy to reason about:
// identical vectors score 1, orthogonal vectors score 0.
const TOPIC_A = [1, 0, 0, 0];
const TOPIC_B = [0, 1, 0, 0];

describe("computeCrossSemanticCandidates", () => {
	it("returns nothing when there's no vault index (every candidate needs a vault side)", () => {
		const mail = { chunks: [{ id: "m1", subject: "Renewal", from: "a@b.com", receivedAt: "2026-01-01", text: "renew the policy", embedding: TOPIC_A }] };
		expect(computeCrossSemanticCandidates(null, mail, null)).toEqual([]);
	});

	it("pairs a vault note with a strongly-similar mail message, above threshold", () => {
		const vault = { chunks: [{ path: "Notes/Insurance.md", title: "Insurance", text: "notes about the car insurance policy", embedding: TOPIC_A }] };
		const mail = { chunks: [{ id: "m1", subject: "Policy renewal", from: "a@b.com", receivedAt: "2026-01-01", text: "your policy renews next month", embedding: TOPIC_A }] };
		const out = computeCrossSemanticCandidates(vault, mail, null);
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ vaultPath: "Notes/Insurance.md", relatedDomain: "mail", relatedRef: "m1", score: 1 });
	});

	it("drops a pair below the similarity threshold", () => {
		const vault = { chunks: [{ path: "Notes/Insurance.md", title: "Insurance", text: "notes about the car insurance policy", embedding: TOPIC_A }] };
		const mail = { chunks: [{ id: "m1", subject: "Unrelated", from: "a@b.com", receivedAt: "2026-01-01", text: "totally different topic", embedding: TOPIC_B }] };
		expect(computeCrossSemanticCandidates(vault, mail, null)).toEqual([]);
	});

	it("considers files too, and caps output to maxPairs with the strongest scores first", () => {
		const vault = {
			chunks: [
				{ path: "Notes/A.md", title: "A", text: "topic a note", embedding: TOPIC_A },
				{ path: "Notes/B.md", title: "B", text: "topic b note", embedding: TOPIC_B },
			],
		};
		const files = {
			chunks: [
				{ path: "docs/a.txt", text: "topic a file", embedding: TOPIC_A },
				{ path: "docs/b.txt", text: "topic b file", embedding: TOPIC_B },
			],
		};
		const out = computeCrossSemanticCandidates(vault, null, files, 1);
		expect(out).toHaveLength(1);
		expect(out[0].relatedDomain).toBe("files");
	});

	it("skips chunks that failed to embed rather than scoring them", () => {
		const vault = { chunks: [{ path: "Notes/A.md", title: "A", text: "x", embedding: [] }] };
		const mail = { chunks: [{ id: "m1", subject: "x", from: "a@b.com", receivedAt: "2026-01-01", text: "x", embedding: TOPIC_A }] };
		expect(computeCrossSemanticCandidates(vault, mail, null)).toEqual([]);
	});

	it("uses only one representative chunk per document, not every chunk", () => {
		const vault = {
			chunks: [
				{ path: "Notes/A.md", title: "A", text: "first chunk", embedding: TOPIC_A },
				{ path: "Notes/A.md", title: "A", text: "second chunk", embedding: TOPIC_A },
			],
		};
		const mail = { chunks: [{ id: "m1", subject: "x", from: "a@b.com", receivedAt: "2026-01-01", text: "match", embedding: TOPIC_A }] };
		expect(computeCrossSemanticCandidates(vault, mail, null)).toHaveLength(1);
	});
});
