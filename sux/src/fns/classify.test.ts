import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	llm: vi.fn(async () => 'noise before {"labels":["spam","bogus"],"why":"sales pitch"} noise after'),
}));

import { classify } from "./classify";
import { llm } from "../ai";

const env = { AI: { run: vi.fn() } } as any;

afterEach(() => vi.clearAllMocks());

describe("classify", () => {
	it("fails without the AI binding", async () => {
		const r = await classify.run({} as any, { text: "buy now", labels: ["spam", "ham"] });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Workers AI/);
	});

	it("requires text and at least 2 labels", async () => {
		expect((await classify.run(env, { labels: ["a", "b"] })).isError).toBe(true);
		expect((await classify.run(env, { text: "hi", labels: ["only"] })).isError).toBe(true);
	});

	it("parses the JSON and keeps only known labels", async () => {
		const r = await classify.run(env, { text: "buy now", labels: ["spam", "ham"] });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.labels).toEqual(["spam"]);
		expect(parsed.why).toBe("sales pitch");
	});

	it("switches the prompt for multi-label mode", async () => {
		await classify.run(env, { text: "x", labels: ["a", "b"], multi: true });
		expect((llm as any).mock.calls[0][1]).toMatch(/all applicable labels/);
	});
});
