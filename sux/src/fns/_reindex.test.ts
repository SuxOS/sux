import { describe, expect, it, vi } from "vitest";

// The backfill/repopulate path (#1290): reindexCorpus reads the existing corpus and upserts
// every chunk into `sux-corpus` under its namespace, reusing stored embeddings. Mock the
// index builders + the _source chunk store (their own suites cover building); assert the
// upsert fan-out, the per-domain report, idempotency (stable ids), and the no-binding throw.
vi.mock("./_vault_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), vaultSemanticIndex: vi.fn() }));
vi.mock("./_mail_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), mailSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_files_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), filesSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_contact_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), contactSemanticIndex: vi.fn(async () => null) }));
vi.mock("./_source", async (importOriginal) => ({ ...(await importOriginal<object>()), listDomains: vi.fn(async () => []), listChunks: vi.fn(async () => []) }));
vi.mock("./obsidian", async (importOriginal) => ({ ...(await importOriginal<object>()), vaultCfg: vi.fn(() => ({ repo: "owner/repo", branch: "main", dir: "", inVault: (p: string) => p })) }));

import { queryCorpus, vectorId } from "./_vectorize";
import { listChunks, listDomains } from "./_source";
import { vaultSemanticIndex } from "./_vault_semantic";
import { reindexCorpus } from "./_reindex";

const vaultBuild = vaultSemanticIndex as unknown as ReturnType<typeof vi.fn>;
const domainsList = listDomains as unknown as ReturnType<typeof vi.fn>;
const chunksList = listChunks as unknown as ReturnType<typeof vi.fn>;

function makeVectorize() {
	const store = new Map<string, VectorizeVector>();
	return {
		store,
		upsert: async (vectors: VectorizeVector[]) => {
			for (const v of vectors) store.set(v.id, v);
			return { mutationId: "m" };
		},
		query: async (vector: number[], opts: VectorizeQueryOptions = {}) => {
			const scored = [...store.values()].filter((v) => opts.namespace === undefined || v.namespace === opts.namespace).map((v) => ({ id: v.id, namespace: v.namespace, metadata: v.metadata, score: 1 }));
			return { matches: scored.slice(0, opts.topK ?? 5), count: scored.length };
		},
		deleteByIds: async () => ({ mutationId: "d" }),
	};
}

describe("reindexCorpus (#1290 backfill)", () => {
	it("throws when the Vectorize binding is absent (nothing to populate)", async () => {
		await expect(reindexCorpus({} as any)).rejects.toThrow(/not bound/);
	});

	it("backfills vault chunks (grouped per note) and reports per-domain counts", async () => {
		const vx = makeVectorize();
		const env = { VECTORIZE: vx, OBSIDIAN_VAULT_REPO: "owner/repo" } as any;
		vaultBuild.mockResolvedValue({
			sha: "h",
			version: 2,
			at: 1,
			total: 2,
			truncated: false,
			chunks: [
				{ path: "a.md", title: "a", text: "a1", embedding: [1, 0, 0] },
				{ path: "a.md", title: "a", text: "a2", embedding: [0, 1, 0] },
				{ path: "b.md", title: "b", text: "b1", embedding: [0, 0, 1] },
			],
		});
		const report = await reindexCorpus(env, { domains: ["vault"] });
		expect(report.index).toBe("sux-corpus");
		expect(report.domains.vault.indexed).toBe(3);
		expect(report.total).toBe(3);
		expect(vx.store.size).toBe(3);
		// a.md's two chunks got distinct ids (sub 0/1); pointer round-trips.
		const hits = await queryCorpus(env, "vault", [1, 0, 0], 5);
		expect(hits.every((h) => h.pointer === "vault:a.md" || h.pointer === "vault:b.md")).toBe(true);
	});

	it("is idempotent: re-running the same backfill upserts in place, never duplicates", async () => {
		const vx = makeVectorize();
		const env = { VECTORIZE: vx, OBSIDIAN_VAULT_REPO: "owner/repo" } as any;
		vaultBuild.mockResolvedValue({ sha: "h", version: 2, at: 1, total: 1, truncated: false, chunks: [{ path: "a.md", title: "a", text: "a1", embedding: [1, 0, 0] }] });
		await reindexCorpus(env, { domains: ["vault"] });
		await reindexCorpus(env, { domains: ["vault"] });
		expect(vx.store.size).toBe(1);
	});

	it("source-chunk sweep keys off the KV chunk id — matching the write-path tap's id", async () => {
		const vx = makeVectorize();
		const env = { VECTORIZE: vx } as any;
		domainsList.mockResolvedValue(["oracle:atomic_habits"]);
		chunksList.mockResolvedValue([{ id: "kv1", source_id: "s1", domain: "oracle:atomic_habits", authority: "authoritative", title: "book", text: "make it obvious", embedding: [1, 0, 0] }]);
		const report = await reindexCorpus(env, { domains: ["source"] });
		expect(report.domains.source.indexed).toBe(1);
		// The stored vector's id is exactly vectorId("oracle", chunkId, "") — the shared scheme.
		expect(vx.store.has(await vectorId("oracle", "kv1", ""))).toBe(true);
		const hits = await queryCorpus(env, "oracle", [1, 0, 0], 5);
		expect(hits[0].pointer).toBe("whitelisted:atomic_habits"); // authoritative → whitelisted
	});

	it("captures a per-domain failure without sinking the rest of the backfill", async () => {
		const vx = makeVectorize();
		const env = { VECTORIZE: vx, OBSIDIAN_VAULT_REPO: "owner/repo" } as any;
		vaultBuild.mockRejectedValue(new Error("vault build boom"));
		domainsList.mockResolvedValue([]);
		const report = await reindexCorpus(env, { domains: ["vault", "source"] });
		expect(report.domains.vault.error).toMatch(/boom/);
		expect(report.domains.source.indexed).toBe(0); // ran despite vault failing
	});
});
