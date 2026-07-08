import { afterEach, describe, expect, it, vi } from "vitest";
import { dropbox } from "./dropbox";

const ENV = { DROPBOX_TOKEN: "dbx" } as any;

describe("dropbox (app-folder blob store)", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("reports when DROPBOX_TOKEN isn't configured", async () => {
		const r = await dropbox.run({} as any, { op: "list" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/DROPBOX_TOKEN/);
	});

	it("put uploads bytes and returns a fresh shared link", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/upload")) {
				expect(init.headers.Authorization).toBe("Bearer dbx");
				expect(JSON.parse(init.headers["Dropbox-API-Arg"])).toMatchObject({ path: "/notes/a.pdf", mode: "overwrite" });
				expect(init.body).toBeInstanceOf(Uint8Array);
				return new Response(JSON.stringify({ path_display: "/notes/a.pdf", size: 3 }), { status: 200 });
			}
			expect(url).toContain("/sharing/create_shared_link_with_settings");
			return new Response(JSON.stringify({ url: "https://www.dropbox.com/s/x/a.pdf" }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "put", path: "notes/a.pdf", base64: Buffer.from("abc").toString("base64") });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, path: "/notes/a.pdf", size: 3, url: "https://www.dropbox.com/s/x/a.pdf" });
	});

	it("put reuses the existing shared link on 409", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/upload")) return new Response(JSON.stringify({ path_display: "/a.txt", size: 2 }), { status: 200 });
			if (url.endsWith("/sharing/create_shared_link_with_settings")) {
				return new Response(JSON.stringify({ error_summary: "shared_link_already_exists/metadata/" }), { status: 409 });
			}
			expect(url).toContain("/sharing/list_shared_links");
			return new Response(JSON.stringify({ links: [{ url: "https://www.dropbox.com/s/old/a.txt" }] }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "put", path: "a.txt", data: "hi" });
		expect(JSON.parse(r.content[0].text).url).toBe("https://www.dropbox.com/s/old/a.txt");
	});

	it("get returns text for textual extensions", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toContain("/files/download");
			expect(JSON.parse(init.headers["Dropbox-API-Arg"]).path).toBe("/notes/x.md");
			return new Response("# hello", { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "get", path: "notes/x.md" });
		expect(r.content[0].text).toBe("# hello");
	});

	it("get returns base64 for binary extensions", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(Buffer.from([1, 2, 3]), { status: 200 })));
		const r = await dropbox.run(ENV, { op: "get", path: "img.png" });
		const out = JSON.parse(r.content[0].text);
		expect(Buffer.from(out.base64, "base64")).toEqual(Buffer.from([1, 2, 3]));
	});

	it("lists a folder", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toContain("/files/list_folder");
			expect(JSON.parse(init.body).path).toBe(""); // app-folder root
			return new Response(JSON.stringify({ entries: [{ ".tag": "file", name: "a.pdf", path_display: "/a.pdf", size: 9 }], has_more: false }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "list" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ dir: "/", count: 1, entries: [{ kind: "file", name: "a.pdf", size: 9 }] });
	});

	it("deletes a path", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toContain("/files/delete_v2");
			expect(JSON.parse(init.body).path).toBe("/a.pdf");
			return new Response(JSON.stringify({ metadata: { path_display: "/a.pdf" } }), { status: 200 });
		}));
		const r = await dropbox.run(ENV, { op: "delete", path: "a.pdf" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ ok: true, deleted: "/a.pdf" });
	});
});
