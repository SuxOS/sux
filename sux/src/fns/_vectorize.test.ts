import { describe, expect, it } from "vitest";
import { cosine } from "./_embed";
import { coarseDomain, deleteCorpusIds, hasVectorize, pointerForSourceChunk, queryCorpus, upsertCorpus, upsertSourceChunks, vectorId } from "./_vectorize";

// A faithful in-memory Vectorize double: stores vectors by id, partitions query by namespace,
// ranks by real cosine — so the substrate's write→read round-trip, namespace isolation, and
// stable-id upsert (dedup) are exercised against Vectorize's actual contract, not a stub.
function makeVectorize() {
	const store = new Map<string, VectorizeVector>();
	return {
		store,
		upsert: async (vectors: VectorizeVector[]) => {
			for (const v of vectors) store.set(v.id, v);
			return { mutationId: "m" };
		},
		query: async (vector: number[], opts: VectorizeQueryOptions = {}) => {
			const ns = opts.namespace;
			const scored = [...store.values()]
				.filter((v) => (ns === undefined ? true : v.namespace === ns))
				.map((v) => ({ id: v.id, namespace: v.namespace, metadata: v.metadata, score: cosine(vector, v.values as number[]) }))
				.sort((a, b) => b.score - a.score)
				.slice(0, opts.topK ?? 5);
			return { matches: scored, count: scored.length };
		},
		deleteByIds: async (ids: string[]) => {
			for (const id of ids) store.delete(id);
			return { mutationId: "d" };
		},
	};
}

function envWith(vec?: ReturnType<typeof makeVectorize>) {
	return { ...(vec ? { VECTORIZE: vec } : {}) } as any;
}

describe("_vectorize substrate", () => {
	it("upsert → query round-trips the pointer, text, and a top cosine score", async () => {
		const vx = makeVectorize();
		const env = envWith(vx);
		await upsertCorpus(env, "vault", [{ sourceKey: "note.md", sub: 0, pointer: "vault:note.md", text: "the mitochondria is the powerhouse", embedding: [1, 0, 0] }]);
		const hits = await queryCorpus(env, "vault", [1, 0, 0], 5);
		expect(hits).toHaveLength(1);
		expect(hits[0].pointer).toBe("vault:note.md");
		expect(hits[0].text).toBe("the mitochondria is the powerhouse");
		expect(hits[0].score).toBeGreaterThan(0.99);
	});

	it("partitions by namespace — a domain query never returns another domain's vectors", async () => {
		const vx = makeVectorize();
		const env = envWith(vx);
		await upsertCorpus(env, "vault", [{ sourceKey: "n1", sub: 0, pointer: "vault:n1", text: "vault chunk", embedding: [1, 0, 0] }]);
		await upsertCorpus(env, "mail", [{ sourceKey: "m1", sub: 0, pointer: "mail:m1", text: "mail chunk", embedding: [1, 0, 0] }]);
		const vaultHits = await queryCorpus(env, "vault", [1, 0, 0], 5);
		const mailHits = await queryCorpus(env, "mail", [1, 0, 0], 5);
		expect(vaultHits.map((h) => h.pointer)).toEqual(["vault:n1"]);
		expect(mailHits.map((h) => h.pointer)).toEqual(["mail:m1"]);
	});

	it("stable ids: re-upserting the same source chunk replaces in place, never duplicates", async () => {
		const vx = makeVectorize();
		const env = envWith(vx);
		const unit = { sourceKey: "note.md", sub: 2, pointer: "vault:note.md", text: "v1", embedding: [0, 1, 0] };
		await upsertCorpus(env, "vault", [unit]);
		await upsertCorpus(env, "vault", [{ ...unit, text: "v2-edited" }]);
		expect(vx.store.size).toBe(1); // one logical chunk → one vector
		const hits = await queryCorpus(env, "vault", [0, 1, 0], 5);
		expect(hits[0].text).toBe("v2-edited"); // the upsert replaced the stored text
	});

	it("vectorId is deterministic in (domain, sourceKey, sub) and ≤64 bytes", async () => {
		const a = await vectorId("vault", "note.md", 0);
		const b = await vectorId("vault", "note.md", 0);
		const c = await vectorId("mail", "note.md", 0);
		const d = await vectorId("vault", "note.md", 1);
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a).not.toBe(d);
		expect(a.length).toBeLessThanOrEqual(64);
	});

	it("deleteCorpusIds removes exactly the given vectors", async () => {
		const vx = makeVectorize();
		const env = envWith(vx);
		await upsertCorpus(env, "vault", [{ sourceKey: "n1", sub: 0, pointer: "vault:n1", text: "a", embedding: [1, 0, 0] }]);
		const id = await vectorId("vault", "n1", 0);
		await deleteCorpusIds(env, [id]);
		expect(vx.store.size).toBe(0);
	});

	it("fails open: no binding ⇒ upsert is a 0-count no-op and query returns []", async () => {
		const env = envWith(); // no VECTORIZE
		expect(hasVectorize(env)).toBe(false);
		expect(await upsertCorpus(env, "vault", [{ sourceKey: "n", sub: 0, pointer: "vault:n", text: "x", embedding: [1, 0, 0] }])).toBe(0);
		expect(await queryCorpus(env, "vault", [1, 0, 0], 5)).toEqual([]);
	});

	it("skips units with no embedding (a transient embed hiccup never poisons the index)", async () => {
		const vx = makeVectorize();
		const env = envWith(vx);
		const sent = await upsertCorpus(env, "vault", [
			{ sourceKey: "good", sub: 0, pointer: "vault:good", text: "ok", embedding: [1, 0, 0] },
			{ sourceKey: "bad", sub: 0, pointer: "vault:bad", text: "no-embed", embedding: [] },
		]);
		expect(sent).toBe(1);
		expect(vx.store.size).toBe(1);
	});
});

describe("_vectorize source-chunk mapping", () => {
	it("coarseDomain collapses the fine _source domain onto its namespace", () => {
		expect(coarseDomain("oracle:atomic_habits")).toBe("oracle");
		expect(coarseDomain("assim:scan")).toBe("assim");
		expect(coarseDomain("phi:medical")).toBe("phi");
		expect(coarseDomain("therapy")).toBe("advise"); // a bare advise domain
	});

	it("pointerForSourceChunk emits the same citation shape the read legs do", () => {
		const base = { id: "c1", source_id: "s1", title: "https://example.com/x", text: "t", embedding: [1] };
		expect(pointerForSourceChunk({ ...base, domain: "oracle:principles", authority: "authoritative" })).toBe("whitelisted:principles");
		expect(pointerForSourceChunk({ ...base, domain: "oracle:principles", authority: "contextual" })).toBe("oracle:principles");
		expect(pointerForSourceChunk({ ...base, domain: "phi:medical", authority: "contextual" })).toBe("phi:medical");
		expect(pointerForSourceChunk({ ...base, domain: "assim:doc", authority: "contextual" })).toBe("https://example.com/x");
		expect(pointerForSourceChunk({ ...base, domain: "therapy", authority: "authoritative" })).toBe("advise:therapy");
	});

	it("upsertSourceChunks and the backfill share one id scheme (live write + reindex collapse to one vector)", async () => {
		const vx = makeVectorize();
		const env = envWith(vx);
		const chunk = { id: "kv-chunk-1", source_id: "s1", domain: "oracle:atomic_habits", authority: "contextual", title: "book", text: "make it obvious", embedding: [1, 0, 0] };
		await upsertSourceChunks(env, [chunk]); // the live putChunk-tap path
		await upsertSourceChunks(env, [chunk]); // the reindex sweep, later — same chunk id
		expect(vx.store.size).toBe(1);
		const hits = await queryCorpus(env, "oracle", [1, 0, 0], 5);
		expect(hits[0].pointer).toBe("oracle:atomic_habits");
		expect(hits[0].text).toBe("make it obvious");
	});
});
