import { describe, expect, it } from "vitest";
import { FUNCTIONS } from "./index";
import { DOMAINS, firstSentence } from "./_surface";

describe("_surface DOMAINS coverage", () => {
	it("covers every registered fn — none fall into the 'other' bucket", () => {
		const covered = new Set(DOMAINS.flatMap((d) => d.leaves));
		const uncovered = FUNCTIONS.map((f) => f.name).filter((n) => !covered.has(n));
		expect(uncovered).toEqual([]);
	});
});

describe("_surface firstSentence", () => {
	it("takes the first sentence and trims", () => {
		expect(firstSentence("Search the web. Then do more.")).toBe("Search the web");
	});

	it("does not truncate at an abbreviation like e.g. or i.e.", () => {
		// The `. ` inside "e.g. " must not be treated as a sentence boundary.
		expect(firstSentence("Convert formats, e.g. markdown and html, at the edge. Second sentence.")).toBe(
			"Convert formats, e.g. markdown and html, at the edge",
		);
		expect(firstSentence("Redact PII, i.e. names and emails, before storing. And more.")).toBe(
			"Redact PII, i.e. names and emails, before storing",
		);
	});

	it("caps overlong first sentences with an ellipsis", () => {
		const long = `${"x".repeat(200)}. next.`;
		const out = firstSentence(long);
		expect(out.length).toBe(140);
		expect(out.endsWith("…")).toBe(true);
	});
});
