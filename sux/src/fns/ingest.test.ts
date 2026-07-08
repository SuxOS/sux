import { afterEach, describe, expect, it, vi } from "vitest";

// The vault write path (ghJson) and loadBytes both go through smartFetch; the
// Dropbox upload uses global fetch — each side is mocked independently.
const routes = vi.hoisted(() => ({ handler: null as null | ((url: string, init?: any) => Response | Promise<Response>) }));
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async (_env: any, url: string, init?: any) => routes.handler!(url, init)),
}));

import { ingest } from "./ingest";

const ENV = { OBSIDIAN_VAULT_REPO: "me/vault" } as any;
const date = new Date().toISOString().slice(0, 10);

/** GitHub contents mock capturing PUTs; everything else 404s (fresh files). */
const ghMock = () => {
	const puts: Record<string, string> = {};
	const handler = (url: string, init?: any): Response => {
		if (init?.method === "PUT") {
			const body = JSON.parse(init.body);
			const path = decodeURIComponent(url.split("/contents/")[1]);
			puts[path] = Buffer.from(body.content, "base64").toString("utf8");
			return new Response(JSON.stringify({ commit: { sha: "c1" } }), { status: 201 });
		}
		return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
	};
	return { puts, handler };
};

describe("ingest (capture → vault)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("requires exactly one source", async () => {
		const r = await ingest.run(ENV, { url: "https://x.com", text: "hi" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/exactly one source/);
	});

	it("captures text into Inbox with provenance frontmatter", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "# Meeting notes\nAlice said yes.", tags: ["meeting"] });
		const out = JSON.parse(r.content[0].text);
		expect(out).toMatchObject({ ok: true, note: `Inbox/${date} meeting-notes.md`, commit: "c1", source: "text" });
		const note = gh.puts[out.note];
		expect(note).toContain("type: capture");
		expect(note).toContain('source: "text"');
		expect(note).toContain("tags: [capture, meeting]");
		expect(note).toContain("Alice said yes.");
	});

	it("captures a web page as markdown, titled from <title>", async () => {
		const gh = ghMock();
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response("<html><head><title>Great Post</title></head><body><h1>Great Post</h1><p>Body <b>bold</b>.</p></body></html>", {
				status: 200,
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		};
		const r = await ingest.run(ENV, { url: "https://blog.example/post" });
		const out = JSON.parse(r.content[0].text);
		expect(out.note).toBe(`Inbox/${date} great-post.md`);
		const note = gh.puts[out.note];
		expect(note).toContain('source: "https://blog.example/post"');
		expect(note).toContain("# Great Post");
		expect(note).toMatch(/\*\*bold\*\*|__bold__/);
	});

	it("commits a small binary into the vault and embeds it", async () => {
		const gh = ghMock();
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(Buffer.from([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { "content-type": "application/pdf" } });
		};
		const r = await ingest.run(ENV, { url: "https://files.example/report.pdf" });
		const out = JSON.parse(r.content[0].text);
		expect(out.blob).toMatchObject({ placement: "vault", size: 4, content_type: "application/pdf" });
		expect(gh.puts[`Attachments/${date}-report.pdf`]).toBeDefined();
		expect(gh.puts[out.note]).toContain(`![[Attachments/${date}-report.pdf]]`);
	});

	it("routes a large binary to Dropbox and links the shared URL", async () => {
		const gh = ghMock();
		const big = new Uint8Array(1_100_000);
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(big, { status: 200, headers: { "content-type": "application/zip" } });
		};
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const s = String(u);
			if (s.endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/attachments/big.zip", size: big.length }), { status: 200 });
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/big.zip" }), { status: 200 });
		}));
		const r = await ingest.run({ ...ENV, DROPBOX_TOKEN: "dbx" }, { url: "https://files.example/big.zip" });
		const out = JSON.parse(r.content[0].text);
		expect(out.blob).toMatchObject({ placement: "dropbox", link: "https://www.dropbox.com/s/x/big.zip" });
		expect(gh.puts[out.note]).toContain("[big.zip](https://www.dropbox.com/s/x/big.zip)");
		expect(gh.puts[`Attachments/${date}-big.zip`]).toBeUndefined();
	});

	it("blobs:'dropbox' forces even a small binary to Dropbox", async () => {
		const gh = ghMock();
		routes.handler = (url, init) => {
			if (url.includes("api.github.com")) return gh.handler(url, init);
			return new Response(Buffer.from([1, 2]), { status: 200, headers: { "content-type": "image/png" } });
		};
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const s = String(u);
			if (s.endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/attachments/i.png", size: 2 }), { status: 200 });
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/i.png" }), { status: 200 });
		}));
		const r = await ingest.run({ ...ENV, DROPBOX_TOKEN: "dbx" }, { url: "https://files.example/i.png", blobs: "dropbox" });
		expect(JSON.parse(r.content[0].text).blob.placement).toBe("dropbox");
	});

	it("explicit path overrides the Inbox default", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "quick thought", path: "Inbox/thought.md" });
		expect(JSON.parse(r.content[0].text).note).toBe("Inbox/thought.md");
		expect(gh.puts["Inbox/thought.md"]).toContain("quick thought");
	});

	it("compress:true stores only the distilled summary", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const env = { ...ENV, AI: { run: async () => ({ response: "• distilled point" }) } };
		const r = await ingest.run(env, { text: "A very long meeting transcript\nline\nline\nline", compress: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.pass).toBe("compressed");
		const note = gh.puts[out.note];
		expect(note).toContain("• distilled point");
		expect(note).toContain("compressed capture");
		expect(note).not.toContain("line\nline\nline");
	});

	it("summarize:true prepends a summary section above the verbatim body", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const env = { ...ENV, AI: { run: async () => ({ response: "One-paragraph gist." }) } };
		const r = await ingest.run(env, { text: "Original body stays.", summarize: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.pass).toBe("summarized");
		const note = gh.puts[out.note];
		expect(note).toContain("## Summary");
		expect(note).toContain("One-paragraph gist.");
		expect(note).toContain("Original body stays.");
	});

	it("passes degrade to verbatim capture when AI is unavailable", async () => {
		const gh = ghMock();
		routes.handler = gh.handler;
		const r = await ingest.run(ENV, { text: "keep me verbatim", summarize: true });
		const out = JSON.parse(r.content[0].text);
		expect(out.ok).toBe(true);
		expect(out.pass).toMatch(/unavailable/);
		expect(gh.puts[out.note]).toContain("keep me verbatim");
	});
});
