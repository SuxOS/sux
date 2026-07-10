import { afterEach, describe, expect, it, vi } from "vitest";
import { hasDropboxFull, listFull, normFull, readFull, searchFull } from "./_dropbox-full";

// Read-only full-Dropbox (Mode B) client. These tests hit the real fetch paths via a
// stub, asserting: the credential is isolated to DROPBOX_FULL_* (its own KV key), reads
// never exceed the inline cap (oversize → a TEMPORARY, non-public link), and search/list
// return REFERENCES only. Mirrors dropbox.test.ts's mint/self-heal patterns.

const fakeKV = (init: Record<string, string> = {}) => {
	const store = new Map(Object.entries(init));
	return { store, get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v), delete: async (k: string) => void store.delete(k) };
};
const TOKEN_URL = "https://api.dropbox.com/oauth2/token";
const FULL_KEY = "sux:dropbox:full:token";
const tokenEnv = () => ({ DROPBOX_FULL_TOKEN: "ft" }) as any;

afterEach(() => vi.unstubAllGlobals());

describe("hasDropboxFull / normFull", () => {
	it("is configured only when the full credential (not Mode A's) is present", () => {
		expect(hasDropboxFull({} as any)).toBe(false);
		expect(hasDropboxFull({ DROPBOX_REFRESH_TOKEN: "rt", DROPBOX_APP_KEY: "ak" } as any)).toBe(false); // Mode A is NOT Mode B
		expect(hasDropboxFull({ DROPBOX_FULL_TOKEN: "ft" } as any)).toBe(true);
		expect(hasDropboxFull({ DROPBOX_FULL_REFRESH_TOKEN: "rt", DROPBOX_FULL_APP_KEY: "ak" } as any)).toBe(true);
		expect(hasDropboxFull({ DROPBOX_FULL_REFRESH_TOKEN: "rt" } as any)).toBe(false); // refresh needs the app key
	});

	it("normalizes to absolute paths with '' as the account root", () => {
		expect(normFull("")).toBe("");
		expect(normFull("/")).toBe("");
		expect(normFull("Documents")).toBe("/Documents");
		expect(normFull("/Documents/")).toBe("/Documents");
		expect(normFull("/a/b/")).toBe("/a/b");
	});
});

describe("auth — isolated to the full credential", () => {
	it("PKCE public client: client_id in body, no Basic auth, caches under the full-only key", async () => {
		const kv = fakeKV();
		const env = { DROPBOX_FULL_REFRESH_TOKEN: "frt", DROPBOX_FULL_APP_KEY: "fak", OAUTH_KV: kv } as any;
		let mints = 0;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u) === TOKEN_URL) {
				mints++;
				expect(init.headers.Authorization).toBeUndefined();
				expect(init.body).toContain("client_id=fak");
				expect(init.body).toContain("refresh_token=frt");
				return new Response(JSON.stringify({ access_token: "sl.full", expires_in: 14400 }), { status: 200 });
			}
			expect(init.headers.Authorization).toBe("Bearer sl.full");
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await listFull(env, "");
		expect(mints).toBe(1);
		expect(kv.store.get(FULL_KEY)).toBe("sl.full");
		expect(kv.store.has("sux:dropbox:token")).toBe(false); // never writes Mode A's key
		await listFull(env, ""); // cache hit
		expect(mints).toBe(1);
	});

	it("confidential client: sends Basic auth when a full secret is set", async () => {
		const env = { DROPBOX_FULL_REFRESH_TOKEN: "frt", DROPBOX_FULL_APP_KEY: "fak", DROPBOX_FULL_APP_SECRET: "fas", OAUTH_KV: fakeKV() } as any;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u) === TOKEN_URL) {
				expect(init.headers.Authorization).toBe(`Basic ${btoa("fak:fas")}`);
				return new Response(JSON.stringify({ access_token: "sl.c", expires_in: 14400 }), { status: 200 });
			}
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await listFull(env, "");
	});

	it("on a 401 it drops the FULL cache and re-mints once", async () => {
		const kv = fakeKV({ [FULL_KEY]: "sl.stale" });
		const env = { DROPBOX_FULL_REFRESH_TOKEN: "frt", DROPBOX_FULL_APP_KEY: "fak", OAUTH_KV: kv } as any;
		let mints = 0;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			if (String(u) === TOKEN_URL) {
				mints++;
				return new Response(JSON.stringify({ access_token: "sl.fresh", expires_in: 14400 }), { status: 200 });
			}
			if (init.headers.Authorization === "Bearer sl.stale") return new Response(JSON.stringify({ error_summary: "invalid_access_token/" }), { status: 401 });
			expect(init.headers.Authorization).toBe("Bearer sl.fresh");
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await listFull(env, "");
		expect(mints).toBe(1);
		expect(kv.store.get(FULL_KEY)).toBe("sl.fresh");
	});
});

describe("searchFull — whole-account, references only", () => {
	it("posts search_v2 with path_prefix + ext filters and returns file references", async () => {
		const env = tokenEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			expect(String(u)).toContain("/files/search_v2");
			const body = JSON.parse(init.body);
			expect(body.query).toBe("invoice");
			expect(body.options.path).toBe("/Documents");
			expect(body.options.file_extensions).toEqual(["pdf", "docx"]); // leading dots stripped
			return new Response(JSON.stringify({ matches: [{ metadata: { metadata: { ".tag": "file", name: "invoice.pdf", path_display: "/Documents/invoice.pdf", size: 12, rev: "0a" } } }], has_more: false }), { status: 200 });
		}));
		const r = await searchFull(env, { query: "invoice", path_prefix: "/Documents", ext: [".pdf", "docx"] });
		expect(r.matches).toEqual([{ kind: "file", name: "invoice.pdf", path: "/Documents/invoice.pdf", size: 12, rev: "0a", modified: undefined }]);
		expect(r.has_more).toBe(false);
	});

	it("omits the path when no prefix is given (whole account) and paginates via continue_v2", async () => {
		const env = tokenEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/search_v2")) {
				expect(JSON.parse(init.body).options.path).toBeUndefined(); // whole account
				return new Response(JSON.stringify({ matches: [], has_more: true, cursor: "CUR" }), { status: 200 });
			}
			expect(url).toContain("/files/search/continue_v2");
			expect(JSON.parse(init.body).cursor).toBe("CUR");
			return new Response(JSON.stringify({ matches: [], has_more: false }), { status: 200 });
		}));
		const page1 = await searchFull(env, { query: "x" });
		expect(page1).toMatchObject({ has_more: true, cursor: "CUR" });
		const page2 = await searchFull(env, { query: "x", cursor: page1.cursor });
		expect(page2.has_more).toBe(false);
	});

	it("surfaces the Dropbox error summary", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error_summary: "invalid_cursor/" }), { status: 409 })));
		await expect(searchFull(tokenEnv(), { query: "x", cursor: "bad" })).rejects.toThrow(/invalid_cursor/);
	});
});

describe("listFull — absolute folders", () => {
	it("lists an absolute folder and paginates through the cursor", async () => {
		const env = tokenEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/list_folder")) {
				expect(JSON.parse(init.body).path).toBe("/Photos");
				return new Response(JSON.stringify({ entries: [{ ".tag": "folder", name: "2024", path_display: "/Photos/2024" }], has_more: true, cursor: "C1" }), { status: 200 });
			}
			expect(url).toContain("/files/list_folder/continue");
			expect(JSON.parse(init.body).cursor).toBe("C1");
			return new Response(JSON.stringify({ entries: [{ ".tag": "file", name: "a.jpg", path_display: "/Photos/a.jpg", size: 5 }], has_more: false }), { status: 200 });
		}));
		const p1 = await listFull(env, "Photos");
		expect(p1).toMatchObject({ has_more: true, cursor: "C1", entries: [{ kind: "folder", name: "2024" }] });
		const p2 = await listFull(env, "Photos", p1.cursor);
		expect(p2).toMatchObject({ has_more: false, entries: [{ kind: "file", name: "a.jpg", size: 5 }] });
	});

	it("lists the account root for the empty path", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_u: string | URL, init?: any) => {
			expect(JSON.parse(init.body).path).toBe(""); // account root
			return new Response(JSON.stringify({ entries: [], has_more: false }), { status: 200 });
		}));
		await listFull(tokenEnv(), "");
	});
});

describe("readFull — bytes with a hard inline cap", () => {
	it("returns text for textual extensions after checking metadata", async () => {
		const env = tokenEnv();
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL, init?: any) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 7, path_display: "/n/x.md", rev: "9" }), { status: 200 });
			expect(url).toContain("/files/download");
			expect(JSON.parse(init.headers["Dropbox-API-Arg"]).path).toBe("/n/x.md");
			return new Response("# hello", { status: 200 });
		}));
		const r = await readFull(env, "/n/x.md");
		expect(r).toMatchObject({ path: "/n/x.md", rev: "9", text: "# hello" });
	});

	it("returns base64 for binary extensions", async () => {
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			if (String(u).endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 3, path_display: "/img.png" }), { status: 200 });
			return new Response(Buffer.from([1, 2, 3]), { status: 200 });
		}));
		const r = await readFull(tokenEnv(), "/img.png");
		expect(Buffer.from(String(r.base64), "base64")).toEqual(Buffer.from([1, 2, 3]));
	});

	it("oversize → a TEMPORARY (expiring, NON-public) link and never downloads", async () => {
		let downloaded = false;
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 500_000_000, path_display: "/big.mov", rev: "z" }), { status: 200 });
			if (url.endsWith("/files/get_temporary_link")) return new Response(JSON.stringify({ link: "https://dl.dropboxusercontent.com/temp/big.mov" }), { status: 200 });
			if (url.includes("/sharing/")) throw new Error("must not mint a permanent public share for a full-scope path");
			downloaded = url.includes("/files/download");
			throw new Error("download must not be attempted for oversize");
		}));
		const r = await readFull(tokenEnv(), "/big.mov");
		expect(r).toMatchObject({ too_large_to_inline: true, size: 500_000_000, temporary_link: "https://dl.dropboxusercontent.com/temp/big.mov" });
		expect(String(r.temporary_link)).not.toContain("dropbox.com/s/"); // not a permanent /s/ share
		expect(downloaded).toBe(false);
	});

	it("oversize with a FAILED temporary-link throws — never a silent success with a missing link", async () => {
		// Regression (adversarial review): a 409/429/401 from get_temporary_link must surface as an
		// error, not a { too_large_to_inline: true, temporary_link: undefined } success.
		vi.stubGlobal("fetch", vi.fn(async (u: string | URL) => {
			const url = String(u);
			if (url.endsWith("/files/get_metadata")) return new Response(JSON.stringify({ ".tag": "file", size: 500_000_000, path_display: "/big.mov" }), { status: 200 });
			if (url.endsWith("/files/get_temporary_link")) return new Response(JSON.stringify({ error_summary: "unsupported_file/" }), { status: 409 });
			throw new Error("download must not be attempted for oversize");
		}));
		await expect(readFull(tokenEnv(), "/big.mov")).rejects.toThrow(/temporary-link error|unsupported_file/);
	});

	it("refuses a folder and an unbounded (no-size) body", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ".tag": "folder" }), { status: 200 })));
		await expect(readFull(tokenEnv(), "/a")).rejects.toThrow(/is a folder/);
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ".tag": "file" }), { status: 200 })));
		await expect(readFull(tokenEnv(), "/weird.bin")).rejects.toThrow(/no size|unbounded/);
	});

	it("requires a real path (root is not a file)", async () => {
		await expect(readFull(tokenEnv(), "")).rejects.toThrow(/requires a file path/);
	});
});
