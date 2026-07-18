import { beforeEach, describe, expect, it, vi } from "vitest";
import { cross_semantic_relate } from "./cross_semantic_relate";

const runVerb = vi.fn();
vi.mock("./run", () => ({ runVerb: (...args: unknown[]) => runVerb(...args) }));

const TOPIC = [1, 0, 0, 0];

describe("cross_semantic_relate", () => {
	beforeEach(() => {
		runVerb.mockReset();
	});

	it("is disabled unless CROSS_SEMANTIC_ENABLED is set", async () => {
		const res = await cross_semantic_relate.run({} as any, {});
		expect(res.isError).toBe(true);
		expect(res.content[0].text).toContain("CROSS_SEMANTIC_ENABLED");
		expect(runVerb).not.toHaveBeenCalled();
	});

	it("scores the domain indices, proposes strong pairs, and starts a durable run", async () => {
		vi.doMock("./_vault_semantic", () => ({
			vaultSemanticIndex: async () => ({ chunks: [{ path: "Notes/Insurance.md", title: "Insurance", text: "car insurance policy", embedding: TOPIC }] }),
		}));
		vi.doMock("./_mail_semantic", () => ({
			mailSemanticIndex: async () => ({ chunks: [{ id: "m1", subject: "Policy renewal", from: "a@b.com", receivedAt: "2026-01-01", text: "your policy renews", embedding: TOPIC }] }),
		}));
		vi.doMock("./_files_semantic", () => ({ filesSemanticIndex: async () => null }));
		vi.doMock("./obsidian", () => ({ vaultCfg: () => ({ repo: "o/r", dir: "" }) }));
		vi.resetModules();
		const { cross_semantic_relate: freshFn } = await import("./cross_semantic_relate");
		runVerb.mockResolvedValueOnce({ instanceId: "xyz789" });

		const res = await freshFn.run({ CROSS_SEMANTIC_ENABLED: "1" } as any, {});

		expect(runVerb).toHaveBeenCalledTimes(1);
		const call = runVerb.mock.calls[0][0];
		expect(call.op).toBe("cross-semantic-relate");
		expect(call.mode).toBe("durable");
		expect(call.input).toHaveLength(1);
		expect(call.input[0]).toMatchObject({ vaultPath: "Notes/Insurance.md", relatedDomain: "mail", relatedRef: "m1" });
		expect(res.isError).toBeUndefined();
		const body = JSON.parse(res.content[0].text);
		expect(body).toMatchObject({ candidates: 1, instanceId: "xyz789" });
	});

	it("skips starting a run when no pair clears the similarity threshold", async () => {
		vi.doMock("./_vault_semantic", () => ({
			vaultSemanticIndex: async () => ({ chunks: [{ path: "Notes/A.md", title: "A", text: "x", embedding: [1, 0, 0, 0] }] }),
		}));
		vi.doMock("./_mail_semantic", () => ({
			mailSemanticIndex: async () => ({ chunks: [{ id: "m1", subject: "y", from: "a@b.com", receivedAt: "2026-01-01", text: "y", embedding: [0, 1, 0, 0] }] }),
		}));
		vi.doMock("./_files_semantic", () => ({ filesSemanticIndex: async () => null }));
		vi.doMock("./obsidian", () => ({ vaultCfg: () => ({ repo: "o/r", dir: "" }) }));
		vi.resetModules();
		const { cross_semantic_relate: freshFn } = await import("./cross_semantic_relate");

		const res = await freshFn.run({ CROSS_SEMANTIC_ENABLED: "1" } as any, {});

		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body).toEqual({ note: "no cross-domain related pairs found above threshold — nothing to link" });
	});

	it("degrades gracefully when the vault isn't configured, instead of erroring", async () => {
		vi.doMock("./obsidian", () => ({ vaultCfg: () => ({ error: "no vault configured" }) }));
		vi.doMock("./_mail_semantic", () => ({ mailSemanticIndex: async () => null }));
		vi.doMock("./_files_semantic", () => ({ filesSemanticIndex: async () => null }));
		vi.resetModules();
		const { cross_semantic_relate: freshFn } = await import("./cross_semantic_relate");

		const res = await freshFn.run({ CROSS_SEMANTIC_ENABLED: "1" } as any, {});

		expect(res.isError).toBeUndefined();
		expect(runVerb).not.toHaveBeenCalled();
		const body = JSON.parse(res.content[0].text);
		expect(body.note).toContain("nothing to link");
	});
});
