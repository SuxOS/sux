import { beforeEach, describe, expect, it, vi } from "vitest";

// A shared, resettable set of stubs the mocked puppeteer.launch() yields, so
// each test can assert what goto received and that close() ran. Declared via
// vi.hoisted so they exist when the (hoisted) vi.mock factory runs.
const stubs = vi.hoisted(() => ({
	goto: vi.fn(async (_url: string, _opts: any) => {}),
	content: vi.fn(async () => "<html>rendered</html>"),
	evaluate: vi.fn(async (_fn: any) => "rendered text"),
	close: vi.fn(async () => {}),
	newPage: vi.fn(),
	launch: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => {
	const page = { goto: stubs.goto, content: stubs.content, evaluate: stubs.evaluate };
	const browser = {
		newPage: stubs.newPage.mockResolvedValue(page as any),
		close: stubs.close,
	};
	return { default: { launch: stubs.launch.mockResolvedValue(browser as any) } };
});

import { render } from "./render";

const BROWSER_ENV = { BROWSER: { fetch: async () => new Response() } } as any;

describe("render", () => {
	beforeEach(() => {
		stubs.goto.mockClear().mockResolvedValue(undefined as any);
		stubs.content.mockClear().mockResolvedValue("<html>rendered</html>");
		stubs.evaluate.mockClear().mockResolvedValue("rendered text");
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
});
