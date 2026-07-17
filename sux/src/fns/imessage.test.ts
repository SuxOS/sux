import { afterEach, describe, expect, it, vi } from "vitest";
import { imessage } from "./imessage";

const ENV = { IMESSAGE_URL: "https://mac.example.ts.net", IMESSAGE_SECRET: "s3cr3t" } as any;
const parse = (r: any) => JSON.parse(r.content[0].text);

afterEach(() => vi.unstubAllGlobals());

describe("imessage", () => {
	it("is inert (not_configured error) without a backend configured", async () => {
		const r = await imessage.run({} as any, { action: "threads" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/IMESSAGE_URL/);
	});

	it("threads: signs the POST and returns the backend's threads", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL, init?: any) => {
				const url = new URL(String(u));
				expect(url.pathname).toBe("/imessage/threads");
				expect(url.searchParams.get("ts")).toBeTruthy();
				expect(url.searchParams.get("sig")).toBeTruthy();
				expect(init.headers["x-signature"]).toBe(url.searchParams.get("sig"));
				expect(JSON.parse(init.body)).toEqual({ contact: "+15551234567" });
				return new Response(JSON.stringify({ threads: [{ id: 1, contact: "+15551234567" }] }), { status: 200 });
			}),
		);
		const out = parse(await imessage.run(ENV, { action: "threads", contact: "+15551234567" }));
		expect(out).toMatchObject({ threads: [{ id: 1, contact: "+15551234567" }] });
	});

	it("messages: requires `thread`", async () => {
		const r = await imessage.run(ENV, { action: "messages" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
	});

	it("messages: posts thread+limit, returns the shaped messages", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL, init?: any) => {
				expect(new URL(String(u)).pathname).toBe("/imessage/messages");
				expect(JSON.parse(init.body)).toEqual({ thread: "42", limit: 10 });
				return new Response(JSON.stringify({ messages: [{ id: 1, text: "hi" }] }), { status: 200 });
			}),
		);
		const out = parse(await imessage.run(ENV, { action: "messages", thread: "42", limit: 10 }));
		expect(out).toMatchObject({ messages: [{ id: 1, text: "hi" }] });
	});

	it("send: rejected without allow_send:true", async () => {
		const r = await imessage.run(ENV, { action: "send", to: "+15551234567", text: "hi" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
		expect(r.content[0].text).toMatch(/allow_send/);
	});

	it("send: requires to and text", async () => {
		const r = await imessage.run(ENV, { action: "send", allow_send: true });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
	});

	it("send: posts to the backend once gated", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (u: string | URL, init?: any) => {
				expect(new URL(String(u)).pathname).toBe("/imessage/send");
				expect(JSON.parse(init.body)).toEqual({ to: "+15551234567", text: "hi" });
				return new Response(JSON.stringify({ ok: true, to: "+15551234567" }), { status: 200 });
			}),
		);
		const out = parse(await imessage.run(ENV, { action: "send", to: "+15551234567", text: "hi", allow_send: true }));
		expect(out).toMatchObject({ ok: true, to: "+15551234567" });
	});

	it("surfaces a node-side {error} as upstream_error", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })));
		const r = await imessage.run(ENV, { action: "threads" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[upstream_error]");
	});

	it("surfaces a transport failure (Mac asleep/off-net) honestly", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("fetch failed");
			}),
		);
		const r = await imessage.run(ENV, { action: "threads" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/unreachable/);
	});

	it("rejects an unknown action", async () => {
		const r = await imessage.run(ENV, { action: "bogus" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toContain("[bad_input]");
	});
});
