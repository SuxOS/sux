import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../ai", () => ({
	hasAI: (env: any) => typeof env?.AI?.run === "function",
	MODELS: { embed: "@cf/baai/bge-base-en-v1.5" },
}));

import { embed } from "./embed";

afterEach(() => vi.clearAllMocks());

describe("embed", () => {
	it("fails without the AI binding", async () => {
		const r = await embed.run({} as any, { text: "hello" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Workers AI/);
	});

	it("requires text or texts", async () => {
		const r = await embed.run({ AI: { run: vi.fn() } } as any, {});
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Provide `text`/);
	});

	it("embeds and returns dims/count/vectors", async () => {
		const run = vi.fn(async () => ({ data: [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]] }));
		const env = { AI: { run } } as any;
		const r = await embed.run(env, { texts: ["a", "b"] });
		expect(r.isError).toBeFalsy();
		const parsed = JSON.parse(r.content[0].text);
		expect(parsed.model).toBe("@cf/baai/bge-base-en-v1.5");
		expect(parsed.dims).toBe(3);
		expect(parsed.count).toBe(2);
		expect(parsed.vectors).toHaveLength(2);
		expect(run).toHaveBeenCalledWith("@cf/baai/bge-base-en-v1.5", { text: ["a", "b"] });
	});

	it("caps the batch at 100 texts", async () => {
		const env = { AI: { run: vi.fn() } } as any;
		const r = await embed.run(env, { texts: Array.from({ length: 101 }, (_, i) => String(i)) });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Cap of 100/);
	});
});
