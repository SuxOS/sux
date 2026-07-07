import puppeteer from "@cloudflare/puppeteer";
import { hmacHex, smartFetch } from "../proxy";
import { type Fn, type RtEnv, type ToolResult, fail, ok } from "../registry";
import { clamp, deliverBytes, fromB64, inlineB64, isHttpUrl } from "./_util";

const WAIT_UNTIL = ["load", "domcontentloaded", "networkidle0", "networkidle2"] as const;

// Paper sizes offered for as:"pdf". Passed straight to page.pdf({ format }).
const PDF_FORMATS = ["A4", "Letter", "Legal", "A3"] as const;

// Output cap: a JS-heavy page can render to multiple MB of HTML/text. Returning
// it wholesale would balloon context and risk the 128MB isolate, so clamp the
// rendered content to a generous-but-bounded size (matches _util.clamp default).
const MAX_OUTPUT_BYTES = 2_000_000;

// Resource types worth aborting when block_resources is on — the heavy, non-text
// fetches that html/text extraction never needs. Kept off screenshots by default
// (image/stylesheet/font/media are exactly what makes a screenshot look right).
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);

// Stealth defaults applied to the page before navigation to blunt the most
// obvious headless-Chromium tells. Kept minimal and inline (no stealth-plugin
// dependency): a realistic desktop UA (no "HeadlessChrome"), a real desktop
// viewport, a plausible accept-language, and a navigator.webdriver mask. The UA
// matches the residential proxy's default header (node/openwrt/fetch.sh) so the
// browser and the proxy present the same client.
const STEALTH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const STEALTH_VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 } as const;
const STEALTH_ACCEPT_LANGUAGE = "en-US,en;q=0.9";

// The slice of puppeteer's Page the stealth setup touches. Structurally typed and
// every method optional so the test stub (and any CF Browser Rendering build that
// lacks a given API) can omit it — each call is individually guarded anyway.
type PageForStealth = {
	setUserAgent?(ua: string): void | Promise<void>;
	setViewport?(v: { width: number; height: number; deviceScaleFactor?: number }): void | Promise<void>;
	setExtraHTTPHeaders?(headers: Record<string, string>): void | Promise<void>;
	evaluateOnNewDocument?(fn: (...args: unknown[]) => unknown): void | Promise<void>;
};

/**
 * Best-effort headless de-fingerprinting, applied BEFORE navigation. Each step is
 * wrapped in its own try/catch: CF Browser Rendering may not support every API, so
 * an unsupported/throwing call degrades silently rather than failing the render.
 * Pairs with residential routing (which fixes the IP signal); this fixes the most
 * obvious BROWSER signals. Deeper stealth isn't attempted (CF Browser Rendering
 * limits it).
 */
async function applyStealth(page: PageForStealth): Promise<void> {
	// Default headless UA contains "HeadlessChrome" — a dead giveaway. Present a
	// realistic current desktop Chrome UA instead (matches the residential proxy's).
	try {
		if (typeof page.setUserAgent === "function") await page.setUserAgent(STEALTH_UA);
	} catch {
		// setUserAgent unsupported on this build — skip; the (headless) UA remains.
	}
	// Headless default viewport is a tell; use a real desktop size.
	try {
		if (typeof page.setViewport === "function") await page.setViewport({ ...STEALTH_VIEWPORT });
	} catch {
		// setViewport unsupported — skip; the default viewport remains.
	}
	// A plausible accept-language. Chromium folds this into outgoing request
	// headers, so the interception handler's req.headers() forwards it residentially
	// too — the browser and the proxy stay consistent without extra plumbing.
	try {
		if (typeof page.setExtraHTTPHeaders === "function") await page.setExtraHTTPHeaders({ "accept-language": STEALTH_ACCEPT_LANGUAGE });
	} catch {
		// setExtraHTTPHeaders unsupported — skip; Chromium's own accept-language stands.
	}
	// Mask navigator.webdriver (true under automation) so page scripts read it as
	// undefined. evaluateOnNewDocument runs the script before any page script.
	try {
		if (typeof page.evaluateOnNewDocument === "function") {
			await page.evaluateOnNewDocument(() => {
				Object.defineProperty(navigator, "webdriver", { get: () => undefined });
			});
		}
	} catch {
		// evaluateOnNewDocument unsupported — skip; navigator.webdriver stays as-is.
	}
}

// Hop-by-hop / framing headers that describe how bytes were transported, not the
// bytes themselves. smartFetch already decoded the body (proxy.ts drops these on
// its own path), so re-emitting them to request.respond would mislead Chromium
// into re-decoding an already-decoded body. Mirror proxiedToResponse's drops.
const STRIP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding"]);

// The slice of puppeteer's HTTPRequest the interception handler touches. Kept
// minimal (and structurally typed) so the test can supply a plain object.
type RequestForInterception = {
	resourceType(): string;
	url(): string;
	method(): string;
	headers(): Record<string, string>;
	postData(): string | undefined;
	abort(): void | Promise<void>;
	continue(): void | Promise<void>;
	respond(r: { status: number; headers: Record<string, string>; contentType?: string; body: Uint8Array }): void | Promise<void>;
};

/**
 * Handle one intercepted browser request. Interception requires EXACTLY one of
 * abort/respond/continue per request, so every path here resolves the request:
 *   - block_resources on + heavy asset (image/font/stylesheet/media) → abort()
 *     (unchanged: skip the asset entirely).
 *   - residential on → smartFetch the URL through the Tailscale proxy, then
 *     fulfil the browser request with the residentially-fetched bytes so the
 *     page sees home-IP content. Framing headers are stripped (smartFetch already
 *     decoded the body). ANY error here degrades to continue() — the browser
 *     fetches it directly rather than the whole render failing.
 *   - otherwise → continue() (browser fetches directly / datacenter).
 */
async function handleRequest(
	env: Parameters<typeof smartFetch>[0],
	req: RequestForInterception,
	opts: { residential: boolean; blockResources: boolean },
): Promise<void> {
	// Abort heavy assets first — same behavior whether or not residential is on.
	if (opts.blockResources && BLOCKED_RESOURCE_TYPES.has(req.resourceType())) {
		try {
			await req.abort();
		} catch {
			// Even abort can race a closing page; swallow so nothing is left un-handled.
		}
		return;
	}
	if (!opts.residential) {
		// Not routing residentially: let the browser fetch it directly (datacenter).
		try {
			await req.continue();
		} catch {
			/* request already resolved by a teardown race — nothing to do. */
		}
		return;
	}
	// Residential route: fetch the subresource through the Tailscale proxy and
	// hand the bytes back to Chromium. On any failure fall back to a direct
	// browser fetch so one bad subresource never fails the whole render.
	try {
		const r = await smartFetch(env, req.url(), { method: req.method(), headers: req.headers(), body: req.postData() });
		const bytes = new Uint8Array(await r.arrayBuffer());
		const headers: Record<string, string> = {};
		let contentType: string | undefined;
		r.headers.forEach((value, key) => {
			const lower = key.toLowerCase();
			if (lower === "content-type") contentType = value;
			if (STRIP_RESPONSE_HEADERS.has(lower)) return; // already-decoded framing headers
			headers[key] = value;
		});
		await req.respond({ status: r.status, headers, contentType, body: bytes });
	} catch {
		// smartFetch threw, arrayBuffer failed, or respond raced a teardown — let
		// the browser try directly rather than leaving the request un-handled.
		try {
			await req.continue();
		} catch {
			/* already resolved elsewhere — safe to ignore. */
		}
	}
}

// Cap on the AbortSignal for the Mac render call. The service egresses
// residentially and solves active JS challenges, so it is legitimately slower
// than CF Browser Rendering — give it the nav budget plus a margin, but keep the
// Worker bounded so a hung node can never hang the tool call indefinitely.
const MAC_TIMEOUT_MARGIN_MS = 10_000;
const MAC_TIMEOUT_CAP_MS = 70_000;

// The render args forwarded to the Mac service (pass-through). Resolved from the
// same values the cf path uses so the two backends behave identically on input.
type MacRenderPayload = {
	url: string;
	as: string;
	wait_until: string;
	wait_ms: number;
	block_resources: boolean;
	full_page: boolean;
	timeout_ms: number;
};

// The Mac service response envelope. For as html/text, `body` is the text; for
// as screenshot/pdf, bodyEncoding is "base64" and `body` is base64 of the bytes.
// On error the node returns `{ error }`.
type MacRenderResponse = {
	status?: number;
	content_type?: string;
	body?: string;
	bodyEncoding?: "base64";
	error?: string;
};

/**
 * Route a render to the Mac patchright service (backend:"mac"): a residential,
 * patched-Chromium node exposed via Tailscale Funnel that solves active JS bot
 * challenges (Akamai sensor) CF Browser Rendering can't. Signed with the SAME
 * HMAC scheme as fetchViaTailscale (hmacHex over `${ts}\n${payload}`, ts+sig on
 * the query string so uhttpd-style hosts that drop POST headers still verify).
 * html/text → ok(body) (clamped like the cf path); screenshot/pdf → base64 body
 * decoded to bytes and delivered via the shared CAS path (honoring `delivery`).
 */
async function renderViaMac(env: RtEnv, payload: MacRenderPayload, delivery: string | undefined): Promise<ToolResult> {
	if (!env.MAC_RENDER_URL || !env.MAC_RENDER_SECRET) {
		return fail("Mac render backend not configured (MAC_RENDER_URL/MAC_RENDER_SECRET).");
	}
	const body = JSON.stringify(payload);
	const ts = String(Date.now());
	const sig = await hmacHex(env.MAC_RENDER_SECRET, `${ts}\n${body}`);
	// ts+sig ride the query string (same rationale as fetchViaTailscale: some CGI
	// hosts drop custom POST headers, but QUERY_STRING is always delivered).
	const endpoint = new URL("/render", env.MAC_RENDER_URL).href;
	const signedEndpoint = `${endpoint}?ts=${ts}&sig=${sig}`;
	const timeout = Math.min(payload.timeout_ms + MAC_TIMEOUT_MARGIN_MS, MAC_TIMEOUT_CAP_MS);
	let resp: Response;
	try {
		resp = await fetch(signedEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
			body,
			signal: AbortSignal.timeout(timeout),
		});
	} catch (e) {
		return fail(`mac render failed: ${String((e as Error).message ?? e)}`);
	}
	let data: MacRenderResponse;
	try {
		data = (await resp.json()) as MacRenderResponse;
	} catch {
		return fail(`mac render failed: unreadable response (HTTP ${resp.status}).`);
	}
	if (!resp.ok || data.error) {
		return fail(`mac render failed: ${data.error ?? `HTTP ${resp.status}`}`);
	}
	const text = typeof data.body === "string" ? data.body : "";
	if (payload.as === "screenshot" || payload.as === "pdf") {
		// Binary output: decode the base64 body and deliver via the SAME CAS path
		// the cf branch uses, honoring `delivery` (default /s/<uuid> ref, base64 to inline).
		const bytes = fromB64(text);
		const contentType = data.content_type ?? (payload.as === "pdf" ? "application/pdf" : "image/png");
		return deliverBytes(env, bytes, contentType, delivery ?? "url", () => inlineB64(bytes, contentType));
	}
	// html/text: body is the text — clamp it exactly like the cf path.
	return ok(clamp(text, MAX_OUTPUT_BYTES));
}

export const render: Fn = {
	name: "render",
	description:
		"Scrape a JavaScript-rendered page via headless Chromium (Cloudflare Browser Rendering). Executes JS, unlike `scrape` (which fetches raw HTML through the residential proxy). " +
		"Give `url` (absolute http(s)); options: wait_until (load|domcontentloaded|networkidle0|networkidle2, default networkidle0), wait_ms (extra delay after load, ≤10000), as (html|text|screenshot|pdf, default html), timeout_ms (nav timeout, default 30000, ≤60000). " +
		"as:screenshot captures a PNG (full_page to shoot the whole scroll height) and returns it as a content-addressed /s/<uuid> URL by default (delivery:base64 to inline). block_resources aborts image/font/stylesheet/media fetches before navigation to speed up html/text extraction (ignored for screenshots to keep them visually correct). " +
		"as:pdf renders the page to a PDF, delivered the same way as a screenshot (content-addressed /s/<uuid> URL by default, delivery:base64 to inline); options format (A4|Letter|Legal|A3, default A4), landscape (default false), print_background (default true so CSS backgrounds render). " +
		"residential (default true) routes the browser's requests through the Tailscale residential proxy so they egress from a home IP instead of the Cloudflare datacenter — the point of this fn, since datacenter IPs are blocked by bot managers like Akamai. Trade-off: slower, because every subresource is proxied one by one; set residential:false to fetch directly from the datacenter (faster, but blockable). With residential and block_resources both on, heavy assets are still aborted and everything else is residential-routed; with residential on and block_resources off, images are proxied too (fully residential, heavier). " +
		"stealth (default true) applies a realistic desktop UA/viewport/accept-language and masks navigator.webdriver to reduce headless-browser fingerprinting so bot managers are less likely to flag the render; pairs with residential routing (which fixes the IP signal). Best-effort — CF Browser Rendering limits deeper stealth, and each step degrades silently if unsupported. Set false to keep the default headless signals. " +
		"backend (cf|mac, default cf) selects the render engine: cf = Cloudflare Browser Rendering (fast, default); mac = a residential patched-browser (patchright) service that egresses from a home IP and SOLVES active JS bot challenges (Akamai sensor) cf can't — slower, use it only for sites that block cf (e.g. Home Depot, Walmart). The mac backend takes url/as/wait_until/wait_ms/block_resources/full_page/timeout_ms; residential/stealth are inherent to it (no separate CF interception), and screenshot/pdf are delivered via the same /s/<uuid> vs base64 `delivery` path.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL to render." },
			wait_until: { type: "string", enum: [...WAIT_UNTIL], default: "networkidle0", description: "Navigation completion condition." },
			wait_ms: { type: "integer", minimum: 0, maximum: 10000, description: "Extra delay (ms) after load, e.g. for late JS." },
			as: { type: "string", enum: ["html", "text", "screenshot", "pdf"], default: "html", description: "Return rendered HTML (default), visible innerText, a PNG screenshot, or a PDF." },
			format: { type: "string", enum: [...PDF_FORMATS], default: "A4", description: "PDF only: paper size." },
			landscape: { type: "boolean", default: false, description: "PDF only: use landscape orientation." },
			print_background: { type: "boolean", default: true, description: "PDF only: render CSS backgrounds (default true)." },
			full_page: { type: "boolean", default: false, description: "Screenshot only: capture the full scroll height, not just the viewport." },
			block_resources: { type: "boolean", default: false, description: "Abort image/font/stylesheet/media requests before navigation to speed up html/text extraction. Ignored for as:screenshot." },
			residential: {
				type: "boolean",
				default: true,
				description:
					"Route the browser's requests through the Tailscale residential proxy so they egress from a home IP, bypassing datacenter-IP bot detection (Akamai etc.). Default true — this is render's main purpose. Slower (every subresource is proxied); set false to fetch directly from the datacenter.",
			},
			stealth: {
				type: "boolean",
				default: true,
				description:
					"Apply a realistic desktop UA/viewport/accept-language and mask navigator.webdriver to reduce headless-browser fingerprinting (bot managers like Akamai flag the default HeadlessChrome signals). Default true — pairs with residential routing. Best-effort (CF Browser Rendering limits deeper stealth); set false to keep default headless signals.",
			},
			delivery: { type: "string", enum: ["base64", "url"], default: "url", description: "Screenshot only: content-addressed /s/<uuid> URL (default, ~100 tokens) or inline base64." },
			backend: {
				type: "string",
				enum: ["cf", "mac"],
				default: "cf",
				description:
					"Render engine: cf = Cloudflare Browser Rendering (fast, default); mac = residential patched-browser service that solves active JS bot challenges (Akamai) — slower, use for sites that block cf (e.g. Home Depot, Walmart).",
			},
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
		const as = args?.as === "text" ? "text" : args?.as === "screenshot" ? "screenshot" : args?.as === "pdf" ? "pdf" : "html";
		const fullPage = args?.full_page === true;
		const format = (PDF_FORMATS as readonly string[]).includes(args?.format) ? args.format : "A4";
		const landscape = args?.landscape === true;
		// Default TRUE so CSS backgrounds render in the PDF; explicit false opts out.
		const printBackground = args?.print_background !== false;
		// Blocking image/media/font/stylesheet fetches would strip a screenshot (or a
		// PDF's backgrounds) of exactly what makes it look right — honor it only for
		// text/html extraction.
		const blockResources = args?.block_resources === true && as !== "screenshot" && as !== "pdf";
		// Default TRUE: bypassing datacenter-IP bot detection is this fn's whole
		// point. Only an explicit false opts back into the direct datacenter path.
		const residential = args?.residential !== false;
		// Default TRUE: getting past bot detection is render's purpose, so reduce the
		// most obvious headless-Chromium tells by default. Explicit false keeps them.
		const stealth = args?.stealth !== false;

		let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
		try {
			browser = await puppeteer.launch(env.BROWSER);
			const page = await browser.newPage();
			// Reduce headless-Chromium fingerprinting before navigation. Best-effort and
			// self-guarding — an unsupported step degrades silently, never fails the render.
			if (stealth) await applyStealth(page as unknown as PageForStealth);
			// Interception is needed whenever we abort heavy assets (block_resources)
			// OR route requests residentially. When neither is on, the browser fetches
			// directly from the datacenter with no interception (today's behavior).
			if (residential || blockResources) {
				await page.setRequestInterception(true);
				page.on("request", (req: RequestForInterception) => {
					void handleRequest(env, req, { residential, blockResources });
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
			if (as === "pdf") {
				const doc = await page.pdf({ format, landscape, printBackground });
				const bytes = doc instanceof Uint8Array ? doc : new Uint8Array(doc as ArrayBuffer);
				// PDF is binary — deliver via the same CAS path as screenshots (default a
				// /s/<uuid> ref); the store's own size cap bounds it, not the text clamp.
				return deliverBytes(env, bytes, "application/pdf", args?.delivery ?? "url", () => inlineB64(bytes, "application/pdf"));
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
