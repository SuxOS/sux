import { beforeEach, describe, expect, it, vi } from "vitest";

// A shared, resettable set of stubs the mocked puppeteer.launch() yields, so
// each test can assert what goto received and that close() ran. Declared via
// vi.hoisted so they exist when the (hoisted) vi.mock factory runs.
const stubs = vi.hoisted(() => ({
	goto: vi.fn(async (_url: string, _opts: any) => {}),
	content: vi.fn(async () => "<html>rendered</html>"),
	evaluate: vi.fn(async (_fn: any) => "rendered text"),
	screenshot: vi.fn(async (_opts: any) => new Uint8Array([0x89, 0x50, 0x4e, 0x47])),
	pdf: vi.fn(async (_opts: any) => new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d])),
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
		pdf: stubs.pdf,
		setRequestInterception: stubs.setRequestInterception,
		on: stubs.on,
	};
	const browser = {
		newPage: stubs.newPage.mockResolvedValue(page as any),
		close: stubs.close,
	};
	return { default: { launch: stubs.launch.mockResolvedValue(browser as any) } };
});

// smartFetch is the residential path render now routes intercepted requests
// through. Mock it so tests can assert the handler calls it and forwards its
// status/body to request.respond, and can simulate a throw for graceful fallback.
const smartFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../proxy", () => ({ smartFetch: smartFetchMock }));

import { render } from "./render";

// Grab the request-interception handler render registered via page.on("request").
// The registered handler is fire-and-forget (`void handleRequest(...)`), so tests
// invoke it via `drive` which also flushes the pending microtask chain (smartFetch
// → arrayBuffer → respond) before assertions run.
function capturedRequestHandler(): (req: any) => Promise<void> {
	const call = stubs.on.mock.calls.find((c) => c[0] === "request");
	if (!call) throw new Error("no request handler was registered");
	const raw = call[1] as (req: any) => void;
	return async (req: any) => {
		raw(req);
		// A handful of macrotask turns drains the async handler's await points
		// (mocked smartFetch resolve, arrayBuffer, respond/continue) deterministically.
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	};
}

// A fake intercepted request whose spies (respond/continue/abort) tests inspect.
function fakeReq(over: Partial<Record<string, any>> = {}) {
	return {
		resourceType: () => over.resourceType ?? "document",
		url: () => over.url ?? "https://example.com/asset",
		method: () => over.method ?? "GET",
		headers: () => over.headers ?? { accept: "*/*" },
		postData: () => over.postData,
		abort: vi.fn(async (): Promise<void> => {}),
		continue: vi.fn(async (): Promise<void> => {}),
		respond: vi.fn(async (_r: { status: number; headers: Record<string, string>; contentType?: string; body: Uint8Array }): Promise<void> => {}),
	};
}

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
		stubs.pdf.mockClear().mockResolvedValue(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]));
		stubs.setRequestInterception.mockClear().mockResolvedValue(undefined as any);
		stubs.on.mockClear();
		stubs.close.mockClear().mockResolvedValue(undefined as any);
		// Return a FRESH Response per call — a Response body can only be read once,
		// so a shared instance would throw on the second intercepted request.
		smartFetchMock.mockClear().mockImplementation(async () => new Response("<html>from-proxy</html>", { status: 200, headers: { "content-type": "text/html" } }));
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

	it("pdf mode delivers a /s/<uuid> CAS ref by default", async () => {
		const r = await render.run(CAS_ENV, { url: "https://example.com", as: "pdf" });
		expect(r.isError).toBeFalsy();
		// Defaults: A4, portrait, backgrounds on.
		expect(stubs.pdf).toHaveBeenCalledWith({ format: "A4", landscape: false, printBackground: true });
		const ref = JSON.parse(r.content[0].text);
		expect(ref.url).toMatch(/\/s\/[0-9a-f-]{36}$/);
		expect(ref.content_type).toBe("application/pdf");
		expect(ref.size).toBe(5); // the mocked %PDF- header bytes
		expect(stubs.close).toHaveBeenCalled();
	});

	it("pdf mode inlines base64 with delivery:base64", async () => {
		const r = await render.run(CAS_ENV, { url: "https://example.com", as: "pdf", delivery: "base64" });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.mime).toBe("application/pdf");
		expect(out.size).toBe(5);
		expect(typeof out.base64).toBe("string");
	});

	it("format/landscape/print_background are passed through to page.pdf", async () => {
		await render.run(CAS_ENV, { url: "https://example.com", as: "pdf", format: "Legal", landscape: true, print_background: false });
		expect(stubs.pdf).toHaveBeenCalledWith({ format: "Legal", landscape: true, printBackground: false });
	});

	it("block_resources (residential off) installs interception and aborts image requests", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", as: "text", block_resources: true, residential: false });
		expect(stubs.setRequestInterception).toHaveBeenCalledWith(true);
		expect(stubs.on).toHaveBeenCalledWith("request", expect.any(Function));
		// Drive the registered handler: an image request aborts, a document continues.
		const handler = capturedRequestHandler();
		const imgReq = fakeReq({ resourceType: "image" });
		await handler(imgReq);
		expect(imgReq.abort).toHaveBeenCalled();
		expect(imgReq.continue).not.toHaveBeenCalled();
		const docReq = fakeReq({ resourceType: "document" });
		await handler(docReq);
		// residential off → the browser fetches the document directly (continue), not smartFetch.
		expect(docReq.continue).toHaveBeenCalled();
		expect(docReq.abort).not.toHaveBeenCalled();
		expect(smartFetchMock).not.toHaveBeenCalled();
	});

	it("block_resources is ignored for screenshots when residential is off", async () => {
		await render.run(CAS_ENV, { url: "https://example.com", as: "screenshot", block_resources: true, residential: false });
		expect(stubs.setRequestInterception).not.toHaveBeenCalled();
		expect(stubs.screenshot).toHaveBeenCalled();
	});

	it("does not install request interception when residential is off and block_resources is off", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", residential: false });
		expect(stubs.setRequestInterception).not.toHaveBeenCalled();
	});

	// --- residential routing (default true) ---

	it("residential:true routes a document request through smartFetch and responds with its bytes", async () => {
		smartFetchMock.mockResolvedValueOnce(
			new Response("<html>proxied-doc</html>", { status: 201, headers: { "content-type": "text/html; charset=utf-8", "content-encoding": "gzip" } }),
		);
		await render.run(BROWSER_ENV, { url: "https://akamai-protected.example" });
		expect(stubs.setRequestInterception).toHaveBeenCalledWith(true);
		const handler = capturedRequestHandler();
		const docReq = fakeReq({ resourceType: "document", url: "https://akamai-protected.example", method: "GET", headers: { accept: "text/html" } });
		await handler(docReq);
		// Fetched residentially with the intercepted request's method/headers/url.
		expect(smartFetchMock).toHaveBeenCalledWith(BROWSER_ENV, "https://akamai-protected.example", {
			method: "GET",
			headers: { accept: "text/html" },
			body: undefined,
		});
		// Fulfilled the browser request with the residential status + bytes.
		expect(docReq.respond).toHaveBeenCalledTimes(1);
		const respondArg = docReq.respond.mock.calls[0][0];
		expect(respondArg.status).toBe(201);
		expect(respondArg.contentType).toBe("text/html; charset=utf-8");
		expect(new TextDecoder().decode(respondArg.body)).toBe("<html>proxied-doc</html>");
		// Framing headers dropped (smartFetch already decoded the body).
		expect(Object.keys(respondArg.headers).map((k) => k.toLowerCase())).not.toContain("content-encoding");
		expect(docReq.continue).not.toHaveBeenCalled();
		expect(docReq.abort).not.toHaveBeenCalled();
	});

	it("residential: a smartFetch throw degrades to request.continue() (never fails the render)", async () => {
		smartFetchMock.mockRejectedValueOnce(new Error("proxy down"));
		await render.run(BROWSER_ENV, { url: "https://example.com" });
		const handler = capturedRequestHandler();
		const req = fakeReq({ resourceType: "script", url: "https://example.com/app.js" });
		await handler(req);
		expect(smartFetchMock).toHaveBeenCalled();
		expect(req.continue).toHaveBeenCalledTimes(1);
		expect(req.respond).not.toHaveBeenCalled();
		expect(req.abort).not.toHaveBeenCalled();
	});

	it("residential on + block_resources on: heavy assets still abort, the rest route residentially", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", as: "text", block_resources: true });
		const handler = capturedRequestHandler();
		// An image is a heavy asset → aborted, never proxied.
		const imgReq = fakeReq({ resourceType: "image" });
		await handler(imgReq);
		expect(imgReq.abort).toHaveBeenCalled();
		expect(smartFetchMock).not.toHaveBeenCalledWith(expect.anything(), "https://example.com/asset", expect.anything());
		// A document is not heavy → residential-routed.
		const docReq = fakeReq({ resourceType: "document", url: "https://example.com/page" });
		await handler(docReq);
		expect(smartFetchMock).toHaveBeenCalledWith(BROWSER_ENV, "https://example.com/page", expect.anything());
		expect(docReq.respond).toHaveBeenCalled();
	});

	it("residential:false does NOT route through smartFetch (browser fetches directly)", async () => {
		await render.run(BROWSER_ENV, { url: "https://example.com", residential: false });
		// No interception installed at all when neither residential nor block_resources is on.
		expect(stubs.setRequestInterception).not.toHaveBeenCalled();
		expect(smartFetchMock).not.toHaveBeenCalled();
	});
});
