import { hmacHex } from "./proxy";
import type { RtEnv } from "./registry";

export type MacRenderSpec = {
	url: string;
	as?: string;
	wait_until?: string;
	wait_ms?: number;
	block_resources?: boolean;
	timeout_ms?: number;
};

type MacRenderResponse = {
	status?: number;
	content_type?: string;
	body?: string;
	bodyEncoding?: "base64";
	error?: string;
};

export type MacRenderResult =
	| { ok: true; contentType: string; body: string; bodyEncoding?: "base64" }
	| { ok: false; error: string };

const MAC_TIMEOUT_MARGIN_MS = 15_000;
const MAC_TIMEOUT_CAP_MS = 80_000;

export async function macRender(env: RtEnv, spec: MacRenderSpec): Promise<MacRenderResult> {
	if (!env.MAC_RENDER_URL || !env.MAC_RENDER_SECRET) {
		return { ok: false, error: "Mac render backend not configured." };
	}
	const payload = JSON.stringify({ as: "html", ...spec });
	const ts = String(Date.now());
	const sig = await hmacHex(env.MAC_RENDER_SECRET, `${ts}\n${payload}`);

	const endpoint = new URL("/render", env.MAC_RENDER_URL).href;
	const signedEndpoint = `${endpoint}?ts=${ts}&sig=${sig}`;
	const timeout = Math.min((spec.timeout_ms ?? 45_000) + MAC_TIMEOUT_MARGIN_MS, MAC_TIMEOUT_CAP_MS);
	let resp: Response;
	try {
		resp = await fetch(signedEndpoint, {
			method: "POST",
			headers: { "content-type": "application/json", "x-timestamp": ts, "x-signature": sig },
			body: payload,
			signal: AbortSignal.timeout(timeout),
		});
	} catch (e) {
		return { ok: false, error: `mac render failed: ${String((e as Error).message ?? e)}` };
	}
	let data: MacRenderResponse;
	try {
		data = (await resp.json()) as MacRenderResponse;
	} catch {
		return { ok: false, error: `mac render failed: unreadable response (HTTP ${resp.status}).` };
	}
	if (!resp.ok || data.error) {
		return { ok: false, error: `mac render failed: ${data.error ?? `HTTP ${resp.status}`}` };
	}
	return {
		ok: true,
		contentType: data.content_type ?? "text/html",
		body: typeof data.body === "string" ? data.body : "",
		bodyEncoding: data.bodyEncoding,
	};
}
