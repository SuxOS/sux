import { afterEach, describe, expect, it, vi } from "vitest";

// The read-path cutover (#1290): `oracle ask`'s vault/mail/files/contacts legs query the
// unified Vectorize index FIRST, falling back to the retained KV cosine cores. These tests
// pin PARITY (Vectorize and brute-force cosine cite the same hits above the floor on one
// fixture), the FALLBACK (a Vectorize error degrades to cosine, never fails the ask), and the
// 0.68 FLOOR through the Vectorize path — using a faithful in-memory Vectorize double.
//
// Mock ONLY the cached cosine readers (their own suites cover building); the topK rankers, the
// floor/citation plumbing, and the real embed/llm all run end-to-end through the oracle fn.
vi.mock("./_vault_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), vaultSemanticIndexCached: vi.fn(async () => null) }));
vi.mock("./_mail_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), mailSemanticIndexCached: vi.fn(async () => null) }));
vi.mock("./_files_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), filesSemanticIndexCached: vi.fn(async () => null) }));
vi.mock("./_contact_semantic", async (importOriginal) => ({ ...(await importOriginal<object>()), contactSemanticIndex: vi.fn(async () => null) }));

import { cosine } from "./_embed";
import type { SemanticIndex } from "./_vault_semantic";
import { vaultSemanticIndexCached } from "./_vault_semantic";
import { upsertCorpus } from "./_vectorize";
import { oracle } from "./oracle";

const vaultIdx = vaultSemanticIndexCached as unknown as ReturnType<typeof vi.fn>;

afterEach(() => vi.clearAllMocks());

/** A Map-backed OAUTH_KV (get/put/delete/list) — the CF KV surface the ask log/oracle KBs use. */
function makeKv() {
	const store = new Map<string, string>();
	return {
		store,
		get: vi.fn(async (k: string) => (store.has(k) ? store.get(k)! : null)),
		put: vi.fn(async (k: string, v: string) => void store.set(k, v)),
		delete: vi.fn(async (k: string) => void store.delete(k)),
		list: vi.fn(async ({ prefix }: { prefix?: string } = {}) => ({
			keys: [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)).map((name) => ({ name })),
			list_complete: true as const,
		})),
	};
}

/** A faithful in-memory Vectorize double — namespace-partitioned, real-cosine-ranked. */
function makeVectorize(throwOnQuery = false) {
	const store = new Map<string, VectorizeVector>();
	return {
		store,
		upsert: async (vectors: VectorizeVector[]) => {
			for (const v of vectors) store.set(v.id, v);
			return { mutationId: "m" };
		},
		query: async (vector: number[], opts: VectorizeQueryOptions = {}) => {
			if (throwOnQuery) throw new Error("vectorize unavailable");
			const scored = [...store.values()]
				.filter((v) => opts.namespace === undefined || v.namespace === opts.namespace)
				.map((v) => ({ id: v.id, namespace: v.namespace, metadata: v.metadata, score: cosine(vector, v.values as number[]) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, opts.topK ?? 5);
			return { matches: scored, count: scored.length };
		},
		deleteByIds: async () => ({ mutationId: "d" }),
	};
}

/** env driving the REAL embed()/llm(): the question embeds to `queryVec` (chunk embeddings are
 *  seeded directly), so cosine against it controls the floor. */
function makeEnv(vx: ReturnType<typeof makeVectorize> | undefined, queryVec: number[]) {
	const kv = makeKv();
	const run = vi.fn(async (_model: string, inputs: any) => {
		if (Array.isArray(inputs?.text)) return { data: inputs.text.map(() => queryVec) };
		return { response: "CITED [vault:a.md] and [vault:b.md]" };
	});
	return { AI: { run }, OAUTH_KV: kv, OBSIDIAN_VAULT_REPO: "owner/repo", ...(vx ? { VECTORIZE: vx } : {}) } as any;
}

// One fixture vault corpus: a=on-topic (cos 1.0), b=on-topic (cos 0.8), c=off-topic (cos ~0.3).
const QUERY_VEC = [1, 0, 0];
const FIXTURE = [
	{ path: "a.md", title: "a", text: "AAA on-topic", embedding: [1, 0, 0] },
	{ path: "b.md", title: "b", text: "BBB on-topic", embedding: [0.8, 0.6, 0] },
	{ path: "c.md", title: "c", text: "CCC off-topic", embedding: [0.3, 0.95, 0] },
];
const fixtureIndex = (): SemanticIndex => ({ sha: "h", version: 2, at: 123, total: 3, truncated: false, chunks: FIXTURE.map((f) => ({ ...f })) });

async function seedVectorizeVault(env: any) {
	await upsertCorpus(
		env,
		"vault",
		FIXTURE.map((f, i) => ({ sourceKey: f.path, sub: i, pointer: `vault:${f.path}`, text: f.text, embedding: f.embedding })),
	);
}

async function ask(env: any): Promise<{ status: string; citations: string[]; domains: any }> {
	const r = await oracle.run(env, { action: "ask", problem: "what's on-topic?" });
	return JSON.parse(r.content[0].text);
}

describe("oracle ask — Vectorize read-path cutover (#1290)", () => {
	it("parity: Vectorize and brute-force cosine cite the SAME hits above the 0.68 floor", async () => {
		// Vectorize-served run: seed the index, leave the cosine reader cold (null).
		const vx = makeVectorize();
		const envVx = makeEnv(vx, QUERY_VEC);
		await seedVectorizeVault(envVx);
		vaultIdx.mockResolvedValue(null);
		const viaVectorize = await ask(envVx);

		// Cosine-served run: no Vectorize binding; the cached reader returns the SAME fixture.
		const envCosine = makeEnv(undefined, QUERY_VEC);
		vaultIdx.mockResolvedValue(fixtureIndex());
		const viaCosine = await ask(envCosine);

		expect(viaVectorize.status).toBe("answered");
		expect(viaCosine.status).toBe("answered");
		// a (1.0) and b (0.8) clear the floor; c (~0.3) does not — identical on both paths.
		expect(new Set(viaVectorize.citations)).toEqual(new Set(["vault:a.md", "vault:b.md"]));
		expect(new Set(viaCosine.citations)).toEqual(new Set(viaVectorize.citations));
		expect(viaVectorize.domains.vault.status).toBe("ok");
	});

	it("floor honored: a corpus with only below-floor vectors is an honest no_match", async () => {
		const vx = makeVectorize();
		const env = makeEnv(vx, QUERY_VEC);
		await upsertCorpus(env, "vault", [{ sourceKey: "c.md", sub: 0, pointer: "vault:c.md", text: "off-topic", embedding: [0.3, 0.95, 0] }]);
		vaultIdx.mockResolvedValue(null);
		const r = await ask(env);
		expect(r.status).toBe("no_match");
		expect(r.citations).toEqual([]);
	});

	it("fallback: a Vectorize query error degrades to the cosine core, never fails the ask", async () => {
		const vx = makeVectorize(true); // query throws
		const env = makeEnv(vx, QUERY_VEC);
		await seedVectorizeVault(env); // present, but query() throws
		vaultIdx.mockResolvedValue(fixtureIndex()); // the cosine fallback still answers
		const r = await ask(env);
		expect(r.status).toBe("answered");
		expect(new Set(r.citations)).toEqual(new Set(["vault:a.md", "vault:b.md"]));
		// The cosine fallback served it — so the leg carries the cosine core's indexed_at.
		expect(r.domains.vault.indexed_at).toBe(123);
	});

	it("empty Vectorize namespace (pre-backfill) falls back to the cosine core", async () => {
		const vx = makeVectorize(); // bound but empty — nothing upserted
		const env = makeEnv(vx, QUERY_VEC);
		vaultIdx.mockResolvedValue(fixtureIndex());
		const r = await ask(env);
		expect(r.status).toBe("answered");
		expect(new Set(r.citations)).toEqual(new Set(["vault:a.md", "vault:b.md"]));
		expect(r.domains.vault.indexed_at).toBe(123); // served by cosine
	});
});
