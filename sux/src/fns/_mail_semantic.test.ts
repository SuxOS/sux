import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./jmap", () => ({ jmap: { run: vi.fn() } }));

import { jmap } from "./jmap";
import { mailSemanticIndex, topKMailByCosine } from "./_mail_semantic";
import { encodeEmbedding } from "./_embed";

const okR = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
const errR = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const run = jmap.run as unknown as ReturnType<typeof vi.fn>;

function kvStub() {
	const store = new Map<string, string>();
	return { store, get: vi.fn(async (k: string) => store.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void store.set(k, v)), delete: vi.fn(async (k: string) => void store.delete(k)) };
}

const EMAILS: Record<string, { id: string; subject: string; from: { email: string }[]; receivedAt: string; preview: string }> = {
	e1: { id: "e1", subject: "Scan results", from: [{ email: "chen@clinic.com" }], receivedAt: "2026-03-01T00:00:00Z", preview: "your imaging results are ready" },
	e2: { id: "e2", subject: "Newsletter", from: [{ email: "news@example.com" }], receivedAt: "2026-03-02T00:00:00Z", preview: "weekly digest" },
};

/** A minimal stand-in for _jmap.ts's real '#'-back-reference resolver (jmap.run is mocked here,
 *  so nothing else resolves buildFull's "#ids":{resultOf:'q',...,path:'/ids'} against the prior
 *  Email/query call's result within the same batch) — just enough (a plain property path, '*'
 *  flattens) to unwrap the one shape _mail_semantic.ts actually sends. */
function resolvePath(value: any, path: string): any {
	let cur = value;
	for (const seg of path.split("/").filter(Boolean)) {
		if (cur == null) return cur;
		cur = seg === "*" ? (Array.isArray(cur) ? cur : [cur]) : Array.isArray(cur) ? cur.map((v) => v?.[seg]) : cur[seg];
	}
	return cur;
}
function resolveArgs(args: any, results: Record<string, any>): any {
	const out: Record<string, any> = {};
	for (const [k, v] of Object.entries(args ?? {})) {
		if (k.startsWith("#") && v && typeof v === "object" && "resultOf" in (v as any)) out[k.slice(1)] = resolvePath(results[(v as any).resultOf], (v as any).path);
		else out[k] = v;
	}
	return out;
}

/** Route a jmapBatch call ([[method,args,callId], ...]) to canned per-method responses. */
function mockBatch(handlers: Record<string, (args: any, callId: string) => [string, any]>) {
	run.mockImplementation(async (_env: any, args: any) => {
		const results: Record<string, any> = {};
		const methodResponses = (args.calls as [string, any, string][]).map(([method, callArgs, callId]) => {
			const resolved = resolveArgs(callArgs, results);
			const h = handlers[method];
			if (!h) return ["error", { type: "unknownMethod" }, callId];
			const [rMethod, rArgs] = h(resolved, callId);
			results[callId] = rArgs;
			return [rMethod, rArgs, callId];
		});
		return okR({ methodResponses });
	});
}

const embedVec = (t: string): number[] => [t.toLowerCase().includes("imaging") || t.toLowerCase().includes("scan") ? 1 : 0, t.toLowerCase().includes("newsletter") || t.toLowerCase().includes("digest") ? 1 : 0, 0.1];
const aiEnv = () => ({ FASTMAIL_TOKEN: "tok", OAUTH_KV: kvStub(), AI: { run: vi.fn(async (_m: string, inputs: any) => ({ data: (inputs.text as string[]).map(embedVec) })) } }) as any;

afterEach(() => vi.clearAllMocks());

describe("_mail_semantic", () => {
	it("returns null when JMAP isn't configured", async () => {
		const idx = await mailSemanticIndex({ AI: { run: vi.fn() } } as any);
		expect(idx).toBeNull();
		expect(run).not.toHaveBeenCalled();
	});

	it("builds a full index (Email/query→get) on a cold cache, anchored on the Email/get response's `state`", async () => {
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1", "e2"], total: 2 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const env = aiEnv();
		const idx = await mailSemanticIndex(env);
		expect(idx?.state).toBe("s1");
		expect(idx?.chunks.map((c) => c.id).sort()).toEqual(["e1", "e2"]);
		expect(await env.OAUTH_KV.get("sux:mail:semantic")).toBeTruthy(); // persisted for the next call
	});

	it("a second call incrementally diffs via Email/changes instead of re-embedding the whole mailbox", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);
		const embedCallsAfterBuild = env.AI.run.mock.calls.length;

		// Now: e2 was created since s1; nothing destroyed.
		mockBatch({
			"Email/changes": (a) => ["Email/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: ["e2"], updated: [], destroyed: [] }],
			"Email/get": (a) => ["Email/get", { list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const idx2 = await mailSemanticIndex(env);
		expect(idx2?.state).toBe("s2");
		expect(idx2?.chunks.map((c) => c.id).sort()).toEqual(["e1", "e2"]);
		// Only e2's text was embedded on the incremental pass — not e1 again.
		expect(env.AI.run.mock.calls.length).toBe(embedCallsAfterBuild + 1);
		expect(env.AI.run.mock.calls[embedCallsAfterBuild][1].text).toEqual(["Newsletter\nweekly digest"]);
	});

	it("an `updated` id (e.g. mail_triage relabeling — keywords/mailboxIds, not content) is kept as-is, not re-embedded", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);
		const embedCallsAfterBuild = env.AI.run.mock.calls.length;

		mockBatch({ "Email/changes": (a) => ["Email/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: [], updated: ["e1"], destroyed: [] }] });
		const idx2 = await mailSemanticIndex(env);
		expect(idx2?.state).toBe("s2");
		expect(idx2?.chunks.map((c) => c.id)).toEqual(["e1"]);
		expect(env.AI.run.mock.calls.length).toBe(embedCallsAfterBuild); // the cached embedding was already valid — no Email/get, no re-embed
	});

	it("drops a destroyed id from the cached chunk set without re-embedding anything", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1", "e2"], total: 2 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);
		const embedCallsAfterBuild = env.AI.run.mock.calls.length;

		mockBatch({ "Email/changes": (a) => ["Email/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: [], updated: [], destroyed: ["e1"] }] });
		const idx2 = await mailSemanticIndex(env);
		expect(idx2?.chunks.map((c) => c.id)).toEqual(["e2"]);
		expect(env.AI.run.mock.calls.length).toBe(embedCallsAfterBuild); // nothing new to embed
	});

	it("falls back to a full rebuild when the server can no longer diff from the cached state (cannotCalculateChanges)", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);

		let queryCalledAgain = false;
		mockBatch({
			"Email/changes": () => ["error", { type: "cannotCalculateChanges" }],
			"Email/query": () => {
				queryCalledAgain = true;
				return ["Email/query", { ids: ["e1", "e2"], total: 2 }];
			},
			"Email/get": (a) => ["Email/get", { state: "s2", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const idx2 = await mailSemanticIndex(env);
		expect(queryCalledAgain).toBe(true);
		expect(idx2?.state).toBe("s2");
		expect(idx2?.chunks.map((c) => c.id).sort()).toEqual(["e1", "e2"]);
	});

	it("a transport failure during the incremental leg also falls back to a full rebuild rather than throwing", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		await mailSemanticIndex(env);

		run.mockImplementationOnce(async () => errR("[upstream_error] JMAP server error (500)."));
		mockBatch({
			// mockImplementationOnce above answers the FIRST call (Email/changes) with a transport error;
			// mockBatch below re-installs the implementation for every call AFTER that one.
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const idx2 = await mailSemanticIndex(env);
		expect(idx2).toBeTruthy(); // recovered via full rebuild instead of throwing
	});

	it("a no-op incremental pass (no created/updated/destroyed) skips the KV write entirely", async () => {
		const env = aiEnv();
		mockBatch({
			"Email/query": () => ["Email/query", { ids: ["e1"], total: 1 }],
			"Email/get": (a) => ["Email/get", { state: "s1", list: (a.ids as string[]).map((id) => EMAILS[id]) }],
		});
		const idx1 = await mailSemanticIndex(env);
		const putCallsAfterBuild = env.OAUTH_KV.put.mock.calls.length;

		mockBatch({ "Email/changes": (a) => ["Email/changes", { oldState: a.sinceState, newState: "s1", hasMoreChanges: false, created: [], updated: [], destroyed: [] }] });
		const idx2 = await mailSemanticIndex(env);
		expect(idx2?.chunks.map((c) => c.id)).toEqual(idx1?.chunks.map((c) => c.id));
		expect(env.OAUTH_KV.put.mock.calls.length).toBe(putCallsAfterBuild); // no re-serialize + put for an unchanged index
	});

	it("truncation past INDEX_MAX evicts the oldest mail by receivedAt, not whatever lands at the array's front", async () => {
		const env = aiEnv();
		// Front-load `kept` (the cached chunk set) with a few RECENT chunks, then a large block of
		// genuinely OLD chunks — reproducing JMAP's "no guaranteed order" so a naive tail-slice would
		// evict the front (the recent chunks) instead of the actual oldest mail.
		const recentChunks = [0, 1, 2].map((i) => ({ id: `recent${i}`, subject: "r", from: "f", receivedAt: `B${String(i).padStart(4, "0")}`, text: "t", embedding: [0, 0, 0.1] }));
		const oldChunks = Array.from({ length: 996 }, (_, i) => ({ id: `old${String(i).padStart(4, "0")}`, subject: "o", from: "f", receivedAt: `A${String(i).padStart(4, "0")}`, text: "t", embedding: [0, 0, 0.1] }));
		const cached = { state: "s1", version: 1, at: 0, total: 999, truncated: false, chunks: [...recentChunks, ...oldChunks] };
		const stored = { ...cached, chunks: cached.chunks.map((c) => ({ ...c, embedding: encodeEmbedding(c.embedding) })) };
		env.OAUTH_KV.store.set("sux:mail:semantic", JSON.stringify(stored));

		const NEW_IDS = [0, 1, 2, 3, 4].map((i) => `new${i}`);
		const NEW_EMAILS: Record<string, { id: string; subject: string; from: { email: string }[]; receivedAt: string; preview: string }> = Object.fromEntries(
			NEW_IDS.map((id) => [id, { id, subject: "fresh", from: [{ email: "x@example.com" }], receivedAt: `C${id}`, preview: "brand new" }]),
		);
		mockBatch({
			"Email/changes": (a) => ["Email/changes", { oldState: a.sinceState, newState: "s2", hasMoreChanges: false, created: NEW_IDS, updated: [], destroyed: [] }],
			"Email/get": (a) => ["Email/get", { list: (a.ids as string[]).map((id) => NEW_EMAILS[id]) }],
		});
		const idx2 = await mailSemanticIndex(env);
		const ids = new Set(idx2?.chunks.map((c) => c.id));
		expect(ids.size).toBe(1000); // 1004 combined, evicted down to INDEX_MAX
		for (const c of recentChunks) expect(ids.has(c.id)).toBe(true); // recent chunks survive despite sitting at the array's front
		for (const id of NEW_IDS) expect(ids.has(id)).toBe(true); // brand new chunks always survive
		for (let i = 0; i < 4; i++) expect(ids.has(`old${String(i).padStart(4, "0")}`)).toBe(false); // the 4 genuinely oldest are evicted
		expect(ids.has("old0004")).toBe(true); // just inside the newest-996 boundary
	});

	it("topKMailByCosine ranks by cosine similarity and skips chunks with no embedding", () => {
		const chunks = [
			{ id: "a", subject: "s", from: "f", receivedAt: "r", text: "t", embedding: [1, 0, 0] },
			{ id: "b", subject: "s", from: "f", receivedAt: "r", text: "t", embedding: [0, 1, 0] },
			{ id: "c", subject: "s", from: "f", receivedAt: "r", text: "t", embedding: [] },
		];
		const hits = topKMailByCosine([1, 0, 0], chunks, 5);
		expect(hits.map((h) => h.id)).toEqual(["a", "b"]);
		expect(hits[0].score).toBeCloseTo(1);
	});
});
