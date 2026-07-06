import puppeteer from "@cloudflare/puppeteer";
import { type Fn, fail, ok } from "../registry";
import { clamp, isHttpUrl } from "./_util";

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

// Output cap: a JS-heavy page can render to multiple MB of HTML/text. Returning
// it wholesale would balloon context and risk the 128MB isolate, so clamp the
// rendered content to a generous-but-bounded size (matches _util.clamp default).
const MAX_OUTPUT_BYTES = 2_000_000;

export const render: Fn = {
	name: "render",
	description:
		"Scrape a JavaScript-rendered page via headless Chromium (Cloudflare Browser Rendering). Executes JS, unlike `scrape` (which fetches raw HTML through the residential proxy). NOTE: egresses from the Cloudflare datacenter, not the residential IP. " +
		"Give `url` (absolute http(s)); options: wait_until (load|domcontentloaded|networkidle0|networkidle2, default networkidle0), wait_ms (extra delay after load, ≤10000), as (html|text, default html), timeout_ms (nav timeout, default 30000, ≤60000).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to render." },
			wait_until: { type: "string", enum: [...WAIT_UNTIL], default: "networkidle0", description: "Navigation completion condition." },
			wait_ms: { type: "integer", minimum: 0, maximum: 10000, description: "Extra delay (ms) after load, e.g. for late JS." },
			as: { type: "string", enum: ["html", "text"], default: "html", description: "Return rendered HTML (default) or visible innerText." },
			timeout_ms: { type: "integer", minimum: 1, maximum: 60000, default: 30000, description: "Navigation timeout in ms." },
		},
	},
	cacheable: true,
	ttl: 300,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!isHttpUrl(url)) return fail("Provide an absolute http(s) url.");
		if (!env.BROWSER) return fail("Browser Rendering is not configured (BROWSER binding).");

		const waitUntil = (WAIT_UNTIL as readonly string[]).includes(args?.wait_until) ? args.wait_until : "networkidle0";
		const timeout = Math.min(Math.max(Number(args?.timeout_ms) || 30000, 1), 60000);
		const waitMs = typeof args?.wait_ms === "number" ? Math.min(Math.max(args.wait_ms, 0), 10000) : 0;
		const as = args?.as === "text" ? "text" : "html";

		let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
		try {
			browser = await puppeteer.launch(env.BROWSER);
			const page = await browser.newPage();
			await page.goto(url, { waitUntil, timeout });
			if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
			// The evaluate callback runs in the browser page (has `document`), not
			// the Worker — reach it via globalThis so the Worker lib (no DOM) checks.
			const content =
				as === "text"
					? await page.evaluate(() => (globalThis as unknown as { document: { body: { innerText: string } } }).document.body.innerText)
					: await page.content();
			return ok(clamp(content, MAX_OUTPUT_BYTES));
		} catch (e) {
			return fail(`render failed: ${String((e as Error).message ?? e)}`);
		} finally {
			if (browser) await browser.close();
		}
	},
};
