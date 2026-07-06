import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	llm: vi.fn(async () => "• point one\n• point two"),
	textFromUrlOr: vi.fn(async (_env: any, text: string, url?: string) => text || (url ? "fetched page text" : "")),
}));

import { summarize } from "./summarize";
import { llm, textFromUrlOr } from "../ai";

const env = { AI: { run: vi.fn() } } as any;

afterEach(() => vi.clearAllMocks());

describe("summarize", () => {
	it("fails without the AI binding", async () => {
		const r = await summarize.run({} as any, { text: "hello world" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Workers AI/);
	});

	it("fails when neither text nor a fetchable url is given", async () => {
		const r = await summarize.run(env, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `text`/);
	});

	it("summarizes provided text and honors max_words", async () => {
		const r = await summarize.run(env, { text: "some long article body", style: "tldr", max_words: 40 });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		const [, system, , maxTokens] = (llm as any).mock.calls[0];
		expect(system).toMatch(/TL;DR/);
		expect(system).toMatch(/under 40 words/);
		expect(maxTokens).toBe(80);
	});

	it("pulls text from a url when no text is given", async () => {
		const r = await summarize.run(env, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(textFromUrlOr).toHaveBeenCalledWith(env, "", "https://example.com");
	});
});
