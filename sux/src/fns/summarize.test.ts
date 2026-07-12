import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	llm: vi.fn(async () => "• point one\n• point two"),
	textFromUrlOr: vi.fn(async (_env: any, text: string, url?: string) => text || (url ? "fetched page text" : "")),
}));

vi.mock("../kagi", () => ({
	kagiTool: vi.fn(async () => ({ content: [{ type: "text", text: "Kagi summary of the page." }] })),
}));

// A readability extraction long enough (>=200 chars) to be summarized locally by Workers AI.
const GOOD_ARTICLE = `Ada Lovelace wrote the first algorithm intended to be carried out by a machine. `.repeat(6);
// Default: a good extraction, so non-YouTube URLs take the local Workers-AI path. Tests that
// exercise the Kagi fallback override this with a short/empty extraction (a failed parse).
const readabilityRun = vi.fn(async (_env?: any, _args?: any) => ({ content: [{ type: "text", text: JSON.stringify({ title: "Ada", text: GOOD_ARTICLE }) }] }));
vi.mock("./readability", () => ({ readability: { name: "readability", run: (...a: any[]) => readabilityRun(a[0], a[1]) } }));

import { summarize } from "./summarize";
import { llm, textFromUrlOr } from "../ai";
import { kagiTool } from "../kagi";

const env = { AI: { run: vi.fn() } } as any;
const kEnv = { ...env, KAGI_API_KEY: "k" } as any;

/** A short (sub-200-char) extraction — the regex parse effectively failed, so summarize
 *  should hand a non-YouTube URL off to Kagi (or the generic net when no Kagi key). */
function weakExtraction() {
	readabilityRun.mockResolvedValueOnce({ content: [{ type: "text", text: JSON.stringify({ text: "too short" }) }] });
}

afterEach(() => {
	vi.clearAllMocks();
	vi.restoreAllMocks();
});

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

	// ---- URL dispatch: ordinary articles go LOCAL first; Kagi earns video/long/weak-extraction ----

	it("summarizes an ordinary article URL locally (readability + Workers AI), never touching Kagi", async () => {
		const r = await summarize.run(kEnv, { url: "https://example.com/post" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		expect(readabilityRun).toHaveBeenCalled();
		// The extracted article body — not the crude whole-page strip — was fed to the model.
		expect((llm as any).mock.calls[0][2]).toContain("Ada Lovelace");
		expect(kagiTool).not.toHaveBeenCalled(); // Kagi is metered — the common case avoids it
		expect(textFromUrlOr).not.toHaveBeenCalled(); // returned from the readability branch
	});

	it("pulls a url locally even with no Kagi key configured", async () => {
		const r = await summarize.run(env, { url: "https://example.com/post" });
		expect(r.isError).toBeFalsy();
		expect(readabilityRun).toHaveBeenCalled();
		expect(llm).toHaveBeenCalled();
		expect(kagiTool).not.toHaveBeenCalled();
	});

	it("routes YouTube URLs to Kagi's Universal Summarizer (transcript access the local path lacks)", async () => {
		const r = await summarize.run(kEnv, { url: "https://www.youtube.com/watch?v=abc", style: "tldr" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("Kagi summary of the page.");
		expect(kagiTool).toHaveBeenCalledWith(kEnv, "kagi_summarizer", { url: "https://www.youtube.com/watch?v=abc", summary_type: "takeaway" });
		expect(readabilityRun).not.toHaveBeenCalled(); // no transcript in the HTML — don't bother extracting
		expect(llm).not.toHaveBeenCalled();
	});

	it("routes youtu.be short links to Kagi too", async () => {
		await summarize.run(kEnv, { url: "https://youtu.be/abc" });
		expect(kagiTool).toHaveBeenCalledWith(kEnv, "kagi_summarizer", { url: "https://youtu.be/abc", summary_type: "summary" });
	});

	it("falls back to Kagi when the article extraction is too weak to summarize", async () => {
		weakExtraction();
		const r = await summarize.run(kEnv, { url: "https://example.com/js-heavy" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("Kagi summary of the page.");
		expect(readabilityRun).toHaveBeenCalled();
		expect(kagiTool).toHaveBeenCalledWith(kEnv, "kagi_summarizer", { url: "https://example.com/js-heavy", summary_type: "summary" });
		expect(llm).not.toHaveBeenCalled(); // never summarized the weak extraction locally
	});

	it("maps bullets/paragraph styles to Kagi summary_type 'summary' on the fallback", async () => {
		weakExtraction();
		await summarize.run(kEnv, { url: "https://example.com/a", style: "bullets" });
		weakExtraction();
		await summarize.run(kEnv, { url: "https://example.com/a", style: "paragraph" });
		expect(kagiTool).toHaveBeenNthCalledWith(1, kEnv, "kagi_summarizer", { url: "https://example.com/a", summary_type: "summary" });
		expect(kagiTool).toHaveBeenNthCalledWith(2, kEnv, "kagi_summarizer", { url: "https://example.com/a", summary_type: "summary" });
	});

	it("falls through to the Workers-AI net when the weak-extraction Kagi call fails", async () => {
		weakExtraction();
		(kagiTool as any).mockRejectedValueOnce(new Error("kagi down"));
		const r = await summarize.run(kEnv, { url: "https://example.com/a" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		expect(llm).toHaveBeenCalled(); // generic textFromUrlOr net summarized the page
	});

	it("falls through to the Workers-AI net when the fallback Kagi resolves with isError", async () => {
		weakExtraction();
		(kagiTool as any).mockResolvedValueOnce({ content: [{ type: "text", text: "kagi_summarizer failed: 502" }], isError: true });
		const r = await summarize.run(kEnv, { url: "https://example.com/a" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		expect(llm).toHaveBeenCalled();
	});

	it("falls through to the Workers-AI net when the fallback Kagi resolves with empty text", async () => {
		weakExtraction();
		(kagiTool as any).mockResolvedValueOnce({ content: [{ type: "text", text: "   \n  " }] });
		const r = await summarize.run(kEnv, { url: "https://example.com/a" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toContain("point one");
		expect(llm).toHaveBeenCalled();
	});

	it("fails (uncacheable) when the fallback fetch hits an upstream 4xx instead of summarizing the error page", async () => {
		weakExtraction();
		(kagiTool as any).mockRejectedValueOnce(new Error("kagi down"));
		(textFromUrlOr as any).mockRejectedValueOnce(new Error("Upstream fetch failed: HTTP 403 — https://example.com/a"));
		const r = await summarize.run(kEnv, { url: "https://example.com/a" });
		expect(r.isError).toBe(true); // isError results never enter the KV cache
		expect(r.content[0].text).toMatch(/HTTP 403/);
		expect(llm).not.toHaveBeenCalled(); // no confident summary of a 403 page
	});

	it("fails (uncacheable) when the Workers-AI model returns an empty summary instead of caching a sentinel", async () => {
		(llm as any).mockResolvedValueOnce("   ");
		const r = await summarize.run(env, { text: "some long article body" });
		expect(r.isError).toBe(true); // isError results never enter the KV cache
		expect(r.content[0].text).toMatch(/empty result/);
	});

	// ---- structured backend logging (observability across the split) ----

	it("tags the Kagi backend in the structured log line", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await summarize.run(kEnv, { url: "https://youtu.be/abc" });
		expect(log).toHaveBeenCalledWith("summarize: backend=kagi url=https://youtu.be/abc");
	});

	it("tags the Workers-AI backend on a locally-extracted article", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await summarize.run(kEnv, { url: "https://example.com/post" });
		expect(log).toHaveBeenCalledWith("summarize: backend=workers-ai url=https://example.com/post");
	});

	it("tags the Workers-AI backend on text input", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await summarize.run(env, { text: "some long article body" });
		expect(log).toHaveBeenCalledWith("summarize: backend=workers-ai");
	});

	it("warns (proxy.ts-style) when the fallback Kagi throws before the Workers-AI net", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		weakExtraction();
		(kagiTool as any).mockRejectedValueOnce(new Error("kagi down"));
		await summarize.run(kEnv, { url: "https://example.com/a" });
		expect(warn).toHaveBeenCalledWith("summarize: Kagi failed, falling back to Workers AI — kagi down");
		expect(log).toHaveBeenCalledWith("summarize: backend=workers-ai url=https://example.com/a");
	});

	it("warns when the fallback Kagi resolves with isError", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		weakExtraction();
		(kagiTool as any).mockResolvedValueOnce({ content: [{ type: "text", text: "kagi_summarizer failed: 502" }], isError: true });
		await summarize.run(kEnv, { url: "https://example.com/a" });
		expect(warn).toHaveBeenCalledWith(
			"summarize: Kagi returned an error — kagi_summarizer failed: 502, falling back to Workers AI — https://example.com/a",
		);
	});

	it("warns when the fallback Kagi resolves with empty text", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		weakExtraction();
		(kagiTool as any).mockResolvedValueOnce({ content: [{ type: "text", text: "   \n  " }] });
		await summarize.run(kEnv, { url: "https://example.com/a" });
		expect(warn).toHaveBeenCalledWith("summarize: Kagi returned an empty summary, falling back to Workers AI — https://example.com/a");
	});

	it("text input never routes to Kagi", async () => {
		const r = await summarize.run(kEnv, { text: "some text" });
		expect(r.isError).toBeFalsy();
		expect(kagiTool).not.toHaveBeenCalled();
	});
});
