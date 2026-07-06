import puppeteer from "@cloudflare/puppeteer";
import { type Fn, fail, ok } from "../registry";
import { clamp, deliverBytes, inlineB64, isHttpUrl } from "./_util";

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

// Output cap: a JS-heavy page can render to multiple MB of HTML/text. Returning
// it wholesale would balloon context and risk the 128MB isolate, so clamp the
// rendered content to a generous-but-bounded size (matches _util.clamp default).
const MAX_OUTPUT_BYTES = 2_000_000;

// Resource types worth aborting when block_resources is on — the heavy, non-text
// fetches that html/text extraction never needs. Kept off screenshots by default
// (image/stylesheet/font/media are exactly what makes a screenshot look right).
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

export const render: Fn = {
	name: "render",
	description:
		"Scrape a JavaScript-rendered page via headless Chromium (Cloudflare Browser Rendering). Executes JS, unlike `scrape` (which fetches raw HTML through the residential proxy). NOTE: egresses from the Cloudflare datacenter, not the residential IP. " +
		"Give `url` (absolute http(s)); options: wait_until (load|domcontentloaded|networkidle0|networkidle2, default networkidle0), wait_ms (extra delay after load, ≤10000), as (html|text|screenshot, default html), timeout_ms (nav timeout, default 30000, ≤60000). " +
		"as:screenshot captures a PNG (full_page to shoot the whole scroll height) and returns it as a content-addressed /s/<uuid> URL by default (delivery:base64 to inline). block_resources aborts image/font/stylesheet/media fetches before navigation to speed up html/text extraction (ignored for screenshots to keep them visually correct).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to render." },
			wait_until: { type: "string", enum: [...WAIT_UNTIL], default: "networkidle0", description: "Navigation completion condition." },
			wait_ms: { type: "integer", minimum: 0, maximum: 10000, description: "Extra delay (ms) after load, e.g. for late JS." },
			as: { type: "string", enum: ["html", "text", "screenshot"], default: "html", description: "Return rendered HTML (default), visible innerText, or a PNG screenshot." },
			full_page: { type: "boolean", default: false, description: "Screenshot only: capture the full scroll height, not just the viewport." },
			block_resources: { type: "boolean", default: false, description: "Abort image/font/stylesheet/media requests before navigation to speed up html/text extraction. Ignored for as:screenshot." },
			delivery: { type: "string", enum: ["base64", "url"], default: "url", description: "Screenshot only: content-addressed /s/<uuid> URL (default, ~100 tokens) or inline base64." },
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
		const as = args?.as === "text" ? "text" : args?.as === "screenshot" ? "screenshot" : "html";
		const fullPage = args?.full_page === true;
		// Blocking image/media/font/stylesheet fetches would strip a screenshot of
		// exactly what makes it look right — honor it only for text/html extraction.
		const blockResources = args?.block_resources === true && as !== "screenshot";

		let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
		try {
			browser = await puppeteer.launch(env.BROWSER);
			const page = await browser.newPage();
			if (blockResources) {
				await page.setRequestInterception(true);
				page.on("request", (req: { resourceType(): string; abort(): void; continue(): void }) => {
					if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) req.abort();
					else req.continue();
				});
			}
			await page.goto(url, { waitUntil, timeout });
			if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
			if (as === "screenshot") {
				const shot = await page.screenshot({ fullPage });
				const bytes = shot instanceof Uint8Array ? shot : new Uint8Array(shot as ArrayBuffer);
				// Screenshot is binary — deliver via the shared CAS helper (default a
				// /s/<uuid> ref, like qr/pdf/image_convert). The store's own size cap
				// bounds it, not the 2MB text clamp.
				return deliverBytes(env, bytes, "image/png", args?.delivery ?? "url", () => inlineB64(bytes, "image/png"));
			}
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
