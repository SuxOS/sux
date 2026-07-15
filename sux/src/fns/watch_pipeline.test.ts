import { describe, expect, it, vi, afterEach } from "vitest";

// Mock global fetch
global.fetch = vi.fn();

import { watch_pipeline } from "./watch_pipeline";

function fakeEnv() {
	const store = new Map<string, string>();
	const env = {
		OAUTH_KV: {
			get: async (k: string) => store.get(k) ?? null,
			put: async (k: string, v: string) => void store.set(k, v),
			delete: async (k: string) => void store.delete(k),
		},
	} as any;
	return { env, store };
}

const mockApiResponse = (data: unknown, opts?: { status?: number; headers?: Record<string, string> }) => {
	vi.mocked(fetch).mockResolvedValueOnce(
		new Response(JSON.stringify(data), {
			status: opts?.status ?? 200,
			headers: { "content-type": "application/json", ...opts?.headers },
		})
	);
};

const parse = (r: any) => JSON.parse(r.content[0].text);

describe("watch_pipeline", () => {
	afterEach(() => {
		vi.clearAllMocks();
	});

	it("rejects invalid owner or repo", async () => {
		const { env } = fakeEnv();
		const r = await watch_pipeline.run(env, { owner: "", repo: "test" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/owner and repo/i);
	});

	it("rejects invalid characters in owner/repo", async () => {
		const { env } = fakeEnv();
		const r = await watch_pipeline.run(env, { owner: "bad@owner", repo: "test" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Invalid/i);
	});

	it("first sight stores the hash and reports first_seen:true, changed:false", async () => {
		const { env, store } = fakeEnv();

		// Mock API responses
		mockApiResponse([{ id: 1, title: "Test PR", state: "open" }]); // PRs
		mockApiResponse([{ id: 2, title: "Test Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const r = await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" });
		expect(r.isError).toBeFalsy();

		const j = parse(r);
		expect(j.owner).toBe("testorg");
		expect(j.repo).toBe("testrepo");
		expect(j.first_seen).toBe(true);
		expect(j.changed).toBe(false);
		expect(j.previous_hash).toBeUndefined();
		expect(typeof j.hash).toBe("string");
		expect(j.hash).toHaveLength(64); // SHA-256 hex
		expect(j.truncated).toBeUndefined();
		expect(r.noCache).toBe(true);

		// Hash was persisted
		const keys = [...store.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^sux:watch_pipeline:/);
		expect(store.get(keys[0])).toBe(j.hash);
	});

	it("identical state on a later check reports changed:false", async () => {
		const { env, store } = fakeEnv();

		// First check
		mockApiResponse([{ id: 1, title: "Test PR", state: "open" }]); // PRs
		mockApiResponse([{ id: 2, title: "Test Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const first = parse(await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" }));

		// Second check with identical state
		mockApiResponse([{ id: 1, title: "Test PR", state: "open" }]); // PRs
		mockApiResponse([{ id: 2, title: "Test Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const second = parse(await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" }));

		expect(second.first_seen).toBe(false);
		expect(second.changed).toBe(false);
		expect(second.hash).toBe(first.hash);
		expect(second.previous_hash).toBe(first.hash);
		expect(store.size).toBe(1);
	});

	it("changed state reports changed:true with previous_hash and updates the store", async () => {
		const { env, store } = fakeEnv();

		// First check
		mockApiResponse([{ id: 1, title: "Test PR", state: "open" }]); // PRs
		mockApiResponse([{ id: 2, title: "Test Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const first = parse(await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" }));

		// Second check with different state (new PR)
		mockApiResponse([
			{ id: 1, title: "Test PR", state: "open" },
			{ id: 3, title: "New PR", state: "open" },
		]); // PRs
		mockApiResponse([{ id: 2, title: "Test Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const second = parse(await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" }));

		expect(second.first_seen).toBe(false);
		expect(second.changed).toBe(true);
		expect(second.previous_hash).toBe(first.hash);
		expect(second.hash).not.toBe(first.hash);

		// Store updated with new hash
		const key = [...store.keys()][0];
		expect(store.get(key)).toBe(second.hash);
	});

	it("handles API errors gracefully", async () => {
		const { env } = fakeEnv();

		// PRs call fails
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "Not Found" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			})
		);

		const r = await watch_pipeline.run(env, { owner: "testorg", repo: "nonexistent" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/\[upstream_error\]/);
	});

	it("surfaces a rate-limit hint instead of a bare status code on 403/429", async () => {
		const { env } = fakeEnv();

		mockApiResponse({ message: "rate limited" }, { status: 403, headers: { "retry-after": "42" } });

		const r = await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/rate limited/i);
		expect(r.content[0].text).toMatch(/42s/);
	});

	it("namespaces distinct repos independently", async () => {
		const { env, store } = fakeEnv();

		// First repo
		mockApiResponse([{ id: 1, title: "Repo1 PR", state: "open" }]); // PRs
		mockApiResponse([{ id: 2, title: "Repo1 Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		await watch_pipeline.run(env, { owner: "org", repo: "repo1" });

		// Different repo with same data should have different hash
		mockApiResponse([{ id: 1, title: "Repo1 PR", state: "open" }]); // PRs
		mockApiResponse([{ id: 2, title: "Repo1 Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const r = await watch_pipeline.run(env, { owner: "org", repo: "repo2" });
		const j = parse(r);
		expect(j.first_seen).toBe(true); // Different repo = independent watch
		expect(store.size).toBe(2); // Two separate KV entries
	});

	it("includes GitHub token in Authorization header when provided", async () => {
		const { env } = fakeEnv();

		mockApiResponse([{ id: 1, title: "Test PR", state: "open" }]); // PRs
		mockApiResponse([{ id: 2, title: "Test Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo", token: "ghp_test123" });

		// Check that fetch was called with Authorization header
		expect(fetch).toHaveBeenCalled();
		const calls = vi.mocked(fetch).mock.calls;
		const hasAuthHeader = calls.some((call) => {
			const headers = call[1]?.headers as any;
			return headers?.Authorization === "Bearer ghp_test123";
		});
		expect(hasAuthHeader).toBe(true);
	});

	it("handles missing optional API endpoints gracefully", async () => {
		const { env } = fakeEnv();

		// PRs
		mockApiResponse([{ id: 1, title: "Test PR", state: "open" }]);
		// Issues
		mockApiResponse([{ id: 2, title: "Test Issue", state: "open" }]);
		// Actions not available
		vi.mocked(fetch).mockResolvedValueOnce(
			new Response(JSON.stringify({ message: "Not Found" }), {
				status: 404,
				headers: { "content-type": "application/json" },
			})
		);

		const r = await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" });
		expect(r.isError).toBeFalsy(); // Should still succeed with partial data
		const j = parse(r);
		expect(j.first_seen).toBe(true);
		expect(j.changed).toBe(false);
	});

	it("filters pull requests out of the /issues response so PR activity isn't double-counted", async () => {
		const { env } = fakeEnv();

		mockApiResponse([{ id: 1, title: "Test PR", state: "open" }]); // PRs
		mockApiResponse([
			{ id: 2, title: "Real Issue", state: "open" },
			{ id: 1, title: "Test PR (as issue)", state: "open", pull_request: { url: "https://api.github.com/repos/o/r/pulls/1" } },
		]); // issues (includes a PR per GitHub's documented /issues behavior)
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const withPr = parse(await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" }));

		// Same state, but the issues call never returns the PR item at all.
		mockApiResponse([{ id: 1, title: "Test PR", state: "open" }]); // PRs
		mockApiResponse([{ id: 2, title: "Real Issue", state: "open" }]); // issues, PR excluded server-side already
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const withoutPr = parse(await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo2" }));

		expect(withPr.hash).toBe(withoutPr.hash);
	});

	it("flags truncated when a resource returns a full page (may have more beyond it)", async () => {
		const { env } = fakeEnv();
		const fullPage = Array.from({ length: 30 }, (_, i) => ({ id: i, title: `PR ${i}`, state: "open" }));

		mockApiResponse(fullPage); // PRs — exactly per_page
		mockApiResponse([{ id: 999, title: "Test Issue", state: "open" }]); // issues
		mockApiResponse({ total_count: 0, workflow_runs: [] }); // actions

		const r = parse(await watch_pipeline.run(env, { owner: "testorg", repo: "testrepo" }));
		expect(r.truncated).toEqual(["pull_requests"]);
	});
});
