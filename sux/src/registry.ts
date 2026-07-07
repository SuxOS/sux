import type { BrowserWorker } from "@cloudflare/puppeteer";
import type { TailscaleEnv } from "./proxy";

// Minimal Workers AI binding surface (summarize/translate/classify/embed/ocr).
// `env.AI` is declared in sux/wrangler.jsonc but absent from the core-generated
// Env type, so we declare just the `run` shape the functions use.
export type AiBinding = {
	run: (model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) => Promise<any>;
};

// Minimal Cloudflare Images binding surface (image_convert). Declared in
// wrangler as `"images": { "binding": "IMAGES" }`; absent in local/test runs.
export type ImagesBinding = {
	input: (data: ReadableStream | ArrayBuffer | Uint8Array) => {
		transform: (opts: Record<string, unknown>) => any;
		output: (opts: Record<string, unknown>) => Promise<{ response: () => Response }>;
	};
};

// Minimal Cloudflare R2 bucket surface (store). Declared in wrangler as
// `"r2_buckets": [{ "binding": "R2", "bucket_name": "sux" }]` once R2 is enabled
// on the account; absent in local/test runs and until then.
export type R2Bucket = {
	put: (key: string, value: ArrayBuffer | Uint8Array | string, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }) => Promise<unknown>;
	get: (key: string) => Promise<null | { size: number; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string>; text: () => Promise<string>; arrayBuffer: () => Promise<ArrayBuffer> }>;
	head: (key: string) => Promise<null | { size: number; uploaded?: Date; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>;
	delete: (key: string) => Promise<void>;
	list: (opts?: { prefix?: string; limit?: number; cursor?: string }) => Promise<{ objects: Array<{ key: string; size: number; uploaded?: Date }>; truncated?: boolean; cursor?: string }>;
};

export type RtEnv = Env &
	TailscaleEnv & {
		KAGI_API_KEY: string;
		ALLOWED_GITHUB_LOGIN: string;
		DEBUG_MCP?: string;
		R2?: R2Bucket;
		// Optional search-provider keys (secrets). Absent → that engine reports it
		// needs configuring; ddg works without any key. Amazon/Walmart/etc. route
		// through SerpAPI when SERPAPI_KEY is set.
		BRAVE_API_KEY?: string;
		BING_API_KEY?: string;
		SERPAPI_KEY?: string;
		// Kroger Public API (api.kroger.com) OAuth client credentials — free at
		// developer.kroger.com. Absent → the kroger fn reports it needs configuring.
		KROGER_CLIENT_ID?: string;
		KROGER_CLIENT_SECRET?: string;
		AI?: AiBinding;
		IMAGES?: ImagesBinding;
		// Cloudflare Browser Rendering binding surface (render). Declared in
		// wrangler as `"browser": { "binding": "BROWSER" }`; absent in
		// local/test runs — the `render` fn fails gracefully when unbound.
		BROWSER?: BrowserWorker;
		// Second render backend (render fn, backend:"mac"): a residential patched-
		// browser (patchright) service on a Mac, exposed via Tailscale Funnel and
		// HMAC-authed with the same scheme as the residential fetch proxy. Solves
		// active JS bot challenges (Akamai) that CF Browser Rendering can't. Absent
		// → backend:"mac" fails gracefully.
		MAC_RENDER_URL?: string;
		MAC_RENDER_SECRET?: string;
		MCP_RATE_LIMITER?: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
	};

// noCache: set on results that must NOT enter the KV cache even though they are
// not errors (e.g. scrape faithfully returning an upstream 4xx/5xx page) — caching
// those poisons repeat calls for an hour.
export type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean; noCache?: boolean };
export const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
export const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export type Fn = {
	name: string;
	description: string;
	inputSchema: unknown;

	cacheable?: boolean;
	// Rate-limit weight: how many per-user limiter tokens a call consumes. Default
	// 1. Set >1 on paid/heavy fns (Browser Rendering, Kagi/SerpAPI, Workers AI) so
	// they throttle before free deterministic fns do. See rate-limit.ts.
	cost?: number;
	// Per-fn cache lifetime in seconds, used only when cacheable. Unset falls
	// back to the global CACHE_TTL_SECONDS (~1h). Set short on volatile external
	// data (search/shop/wayback) and long on pure deterministic transforms.
	ttl?: number;
	// Skip the automatic open/close text normalization (index.ts). Set on
	// byte-exact fns — hashing, encoding, compression, binary/base64 output,
	// crypto, and KV storage — where mutating bytes would corrupt the result.
	raw?: boolean;
	run: (env: RtEnv, args: any) => Promise<ToolResult>;
};

export function toolList(fns: Fn[]): Array<{ name: string; description: string; inputSchema: unknown }> {
	return fns.map((f) => ({ name: f.name, description: f.description, inputSchema: f.inputSchema }));
}

export function findFn(fns: Fn[], name: string): Fn | undefined {
	return fns.find((f) => f.name === name);
}
