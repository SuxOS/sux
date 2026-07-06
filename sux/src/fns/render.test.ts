import { beforeEach, describe, expect, it, vi } from "vitest";

// A shared, resettable set of stubs the mocked puppeteer.launch() yields, so
// each test can assert what goto received and that close() ran. Declared via
// vi.hoisted so they exist when the (hoisted) vi.mock factory runs.
const stubs = vi.hoisted(() => ({
	goto: vi.fn(async (_url: string, _opts: any) => {}),
	content: vi.fn(async () => "<html>rendered</html>"),
	evaluate: vi.fn(async (_fn: any) => "rendered text"),
	screenshot: vi.fn(async (_opts: any) => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
	setRequestInterception: vi.fn(async (_on: boolean) => {}),
	on: vi.fn((_evt: string, _handler: any) => {}),
	close: vi.fn(async () => {}),
	newPage: vi.fn(),
	launch: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => {
	const page = {
		goto: stubs.goto,
		content: stubs.content,
		evaluate: stubs.evaluate,
		screenshot: stubs.screenshot,
		setRequestInterception: stubs.setRequestInterception,
		on: stubs.on,
	};
	const browser = {
		newPage: stubs.newPage.mockResolvedValue(page as any),
		close: stubs.close,
	};
	return { default: { launch: stubs.launch.mockResolvedValue(browser as any) } };
});

import { render } from "./render";

const BROWSER_ENV = { BROWSER: { fetch: async () => new Response() } } as any;
// Screenshot as:"url" delivery goes through deliverBytes → putBlob, which needs
// the R2 + KV bindings; the stubs just have to accept the writes.
const CAS_ENV = { ...BROWSER_ENV, R2: { put: async () => {} }, OAUTH_KV: { put: async () => {} } } as any;

describe("render", () => {
	beforeEach(() => {
		stubs.goto.mockClear().mockResolvedValue(undefined as any);
		stubs.content.mockClear().mockResolvedValue("<html>rendered</html>");
		stubs.evaluate.mockClear().mockResolvedValue("rendered text");
		stubs.screenshot.mockClear().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
		stubs.setRequestInterception.mockClear().mockResolvedValue(undefined as any);
		stubs.on.mockClear();
		stubs.close.mockClear().mockResolvedValue(undefined as any);
	});

	it("html mode returns the rendered content", async () => {
		const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("<html>rendered</html>");
		expect(stubs.content).toHaveBeenCalled();
		expect(stubs.close).toHaveBeenCalled();
	});

	it("text mode returns the page innerText", async () => {
		const r = await render.run(BROWSER_ENV, { url: "https://example.com", as: "text" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toBe("rendered text");
		expect(stubs.evaluate).toHaveBeenCalled();
		expect(stubs.close).toHaveBeenCalled();
	});

	it("passes wait_until and timeout through to goto", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", wait_until: "domcontentloaded", timeout_ms: 5000 });
		expect(stubs.goto).toHaveBeenCalledWith("https://example.com", { waitUntil: "domcontentloaded", timeout: 5000 });
	});

	it("fails when the BROWSER binding is absent", async () => {
		const r = await render.run({} as any, { url: "https://example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/BROWSER binding/);
		expect(stubs.launch).not.toHaveBeenCalledWith(undefined);
	});

	it("rejects a non-http url", async () => {
		const r = await render.run(BROWSER_ENV, { url: "ftp://example.com/x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("closes the browser even when goto throws", async () => {
		stubs.goto.mockRejectedValueOnce(new Error("nav boom"));
		const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/nav boom/);
		expect(stubs.close).toHaveBeenCalled();
	});

	it("caps a huge rendered HTML page instead of returning it wholesale", async () => {
		const huge = "x".repeat(3_000_000);
		stubs.content.mockResolvedValueOnce(huge);
		const r = await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(r.isError).toBeFalsy();
		// Clamped to the 2MB output cap (+ a short truncation marker), not 3MB.
		expect(r.content[0].text.length).toBeLessThan(2_000_100);
		expect(r.content[0].text).toContain("truncated at 2000000 bytes");
	});

	it("caps huge rendered text (as:text) too", async () => {
		const huge = "y".repeat(3_000_000);
		stubs.evaluate.mockResolvedValueOnce(huge);
		const r = await render.run(BROWSER_ENV, { url: "https://example.com", as: "text" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text.length).toBeLessThan(2_000_100);
		expect(r.content[0].text).toContain("truncated at 2000000 bytes");
	});

	it("screenshot mode delivers a /s/<uuid> CAS ref by default", async () => {
		const r = await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot" });
		expect(r.isError).toBeFalsy();
		expect(stubs.screenshot).toHaveBeenCalledWith({ fullPage: false });
		const ref = JSON.parse(r.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.content_type).toBe("image/png");
		expect(ref.size).toBe(4); // the mocked PNG-magic bytes
		expect(stubs.close).toHaveBeenCalled();
	});

	it("screenshot mode inlines base64 with delivery:base64", async () => {
		const r = await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot", delivery: "base64" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.mime).toBe("image/png");
		expect(out.size).toBe(4);
		expect(typeof out.base64).toBe("string");
	});

	it("full_page is passed through to page.screenshot", async () => {
		await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot", full_page: true });
		expect(stubs.screenshot).toHaveBeenCalledWith({ fullPage: true });
	});

	it("block_resources installs request interception and aborts image requests", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", as: "text", block_resources: true });
		expect(stubs.setRequestInterception).toHaveBeenCalledWith(true);
		expect(stubs.on).toHaveBeenCalledWith("request", expect.any(Function));
		// Drive the registered handler: an image request aborts, a document continues.
		const handler = stubs.on.mock.calls.find((c) => c[0] === "request")?.[1] as (req: any) => void;
		const abort = vi.fn();
		const cont = vi.fn();
		handler({ resourceType: () => "image", abort, continue: cont });
		expect(abort).toHaveBeenCalled();
		expect(cont).not.toHaveBeenCalled();
		abort.mockClear();
		cont.mockClear();
		handler({ resourceType: () => "document", abort, continue: cont });
		expect(cont).toHaveBeenCalled();
		expect(abort).not.toHaveBeenCalled();
	});

	it("block_resources is ignored for screenshots (keeps them visually correct)", async () => {
		await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot", block_resources: true });
		expect(stubs.setRequestInterception).not.toHaveBeenCalled();
		expect(stubs.screenshot).toHaveBeenCalled();
	});

	it("does not install request interception by default", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com" });
		expect(stubs.setRequestInterception).not.toHaveBeenCalled();
	});
});
