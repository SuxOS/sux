// Residential fetch proxy — runs on a box in your Tailscale tailnet and does
// outbound fetches from its (residential) IP on behalf of the Cloudflare Worker,
// which egresses from datacenter IPs that big-box retailers (Akamai) block.
//
// Expose it to the Worker with Tailscale Funnel:  tailscale funnel 8787
// The Worker calls  POST https://<node>.<tailnet>.ts.net/fetch  with a bearer
// secret. See README.md.
//
// Zero dependencies — Node 20+ (built-in fetch, node:http, node:dns).

import { createServer } from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT || 8787);
const SECRET = process.env.PROXY_SECRET; // REQUIRED — a strong random string
const MAX_BYTES = Number(process.env.MAX_BYTES || 5 * 1024 * 1024); // 5 MiB cap
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 30_000);
const CLOCK_SKEW_MS = Number(process.env.CLOCK_SKEW_MS || 300_000); // 5 min replay window
// Host allowlist (comma-separated). Empty = allow any public host (SSRF-guarded).
// Suffix match: "homedepot.com" also allows "www.homedepot.com".
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || "")
	.split(",")
	.map((h) => h.trim().toLowerCase())
	.filter(Boolean);

/** Verify the HMAC-SHA256 of `${ts}\n${rawBody}` (timing-safe) + freshness. The
 * `secret` seam defaults to the env SECRET (prod) and is passed explicitly in tests. */
export function verifySignature(ts, rawBody, sigHex, secret = SECRET) {
	if (!ts || !sigHex || !secret) return false;
	if (Math.abs(Date.now() - Number(ts)) > CLOCK_SKEW_MS) return false; // stale/replayed
	const expected = createHmac("sha256", secret).update(`${ts}\n${rawBody}`).digest();
	let given;
	try {
		given = Buffer.from(sigHex, "hex");
	} catch {
		return false;
	}
	return expected.length === given.length && timingSafeEqual(expected, given);
}

/** Suffix-match host allowlist; empty allowlist = allow any public host. The
 * `allowed` seam defaults to the env ALLOWED_HOSTS (prod), overridden in tests. */
export function hostAllowed(host, allowed = ALLOWED_HOSTS) {
	if (allowed.length === 0) return true;
	host = host.toLowerCase();
	return allowed.some((h) => host === h || host.endsWith(`.${h}`));
}

// Default browser-ish headers so targets don't insta-block a botty fingerprint.
const DEFAULT_HEADERS = {
	"user-agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
	accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
	"accept-language": "en-US,en;q=0.9",
	"sec-fetch-dest": "document",
	"sec-fetch-mode": "navigate",
	"sec-fetch-site": "none",
};

/** Reject loopback / private / link-local / CGNAT / metadata targets (SSRF guard). */
export function isPrivateIp(ip) {
	if (ip.includes(":")) {
		// IPv6: unspecified (::), loopback, unique-local (fc00::/7), link-local (fe80::/10), v4-mapped
		// `::` is the v6 twin of 0.0.0.0 (blocked below): connect() to it reaches loopback on Linux.
		const l = ip.toLowerCase();
		if (l === "::" || l === "::1" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb")) return true;
		if (l.startsWith("::ffff:")) return isPrivateIp(l.slice(7));
		return false;
	}
	const p = ip.split(".").map(Number);
	if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return true;
	const [a, b] = p;
	return (
		a === 0 || a === 10 || a === 127 || // this-network, private, loopback
		(a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10 (Tailscale's own range!)
		(a === 169 && b === 254) || // link-local + cloud metadata 169.254.169.254
		(a === 172 && b >= 16 && b <= 31) || // private
		(a === 192 && b === 168) // private
	);
}

async function assertPublicTarget(url) {
	const u = new URL(url); // throws on garbage
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("only http/https allowed");
	if (!hostAllowed(u.hostname)) throw new Error(`host not in allowlist: ${u.hostname}`);
	// Resolve the hostname and check every returned address (blocks DNS-rebinding to internal hosts).
	const host = u.hostname;
	const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
	for (const { address } of addrs) {
		if (isPrivateIp(address)) throw new Error(`target resolves to a private address (${address})`);
	}
	return u;
}

const MAX_REDIRECTS = 8;

/**
 * SSRF-safe redirect follower. The entry URL is guarded by assertPublicTarget,
 * but Node's built-in redirect:"follow" would then chase a 3xx Location into a
 * private/LAN address WITHOUT re-running that guard — a public URL that
 * 302-redirects to http://192.168.1.1/ or http://169.254.169.254/ (cloud
 * metadata) would be fetched from INSIDE the home LAN, defeating the whole
 * SSRF check. So when the caller wants redirects followed, do it manually:
 * fetch each hop with redirect:"manual" and re-validate every Location through
 * `assertTarget` (same public-host + resolved-address check as the entry URL)
 * before fetching it. Callers that ask for redirect:"manual" (the Worker's
 * `redirects` fn tracing a hop chain) never reach here — they get the single
 * 3xx back unchanged. `fetchImpl`/`assertTarget` are injectable seams for tests.
 */
export async function fetchFollowingSafely(startUrl, init, { fetchImpl = fetch, assertTarget = assertPublicTarget, maxHops = MAX_REDIRECTS } = {}) {
	let current = startUrl;
	for (let hop = 0; ; hop++) {
		const resp = await fetchImpl(current, { ...init, redirect: "manual" });
		const location = resp.headers.get("location");
		if (resp.status >= 300 && resp.status < 400 && location) {
			if (hop >= maxHops) throw new Error("too many redirects");
			const next = new URL(location, String(current)); // resolve a relative Location against the current hop
			await assertTarget(next.href); // SSRF re-check EACH hop — refuses a redirect that lands on the LAN
			current = next;
			continue;
		}
		return resp;
	}
}

function json(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(body);
}

async function readBody(req) {
	const chunks = [];
	let size = 0;
	for await (const c of req) {
		size += c.length;
		if (size > 1_000_000) throw new Error("request body too large");
		chunks.push(c);
	}
	return Buffer.concat(chunks).toString("utf8");
}

/**
 * Encode the upstream body for the JSON transport. Always base64 + flag
 * bodyEncoding:"base64" so arbitrary bytes (images, PDFs, archives) survive the
 * JSON string transport and reach the Worker's residential path byte-for-byte —
 * a plain utf8 string mangles any non-UTF-8 byte to U+FFFD, which the Worker then
 * has to refetch DIRECT (defeating residential egress). Matches openwrt/fetch.sh
 * and the Worker's already-tested base64 decode path (src/proxy.ts).
 */
export function encodeBody(buf) {
	return { bodyEncoding: "base64", body: buf.toString("base64") };
}

const server = createServer(async (req, res) => {
	if (req.method === "GET" && (req.url || "").split("?")[0] === "/health") return json(res, 200, { status: "ok" });

	// HMAC-signed `tailscale status --json` passthrough — feeds the Worker health
	// page's residential-egress card (github-handler.ts nodeStatus). GET, so ts+sig
	// ride the query string (and headers); the signed message is `${ts}\n/status`.
	if (req.method === "GET" && (req.url || "").split("?")[0] === "/status") {
		const q = new URLSearchParams((req.url || "").split("?")[1] || "");
		const ts = req.headers["x-timestamp"] || q.get("ts");
		const sig = req.headers["x-signature"] || q.get("sig");
		if (!verifySignature(ts, "/status", sig)) return json(res, 401, { error: "unauthorized" });
		try {
			const { stdout } = await execFileP("tailscale", ["status", "--json"], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
			res.writeHead(200, { "content-type": "application/json" });
			return res.end(stdout);
		} catch (e) {
			return json(res, 500, { error: "tailscale_status_failed", detail: String(e.message || e) });
		}
	}

	if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/fetch") {
		return json(res, 404, { error: "not_found" });
	}

	// Read the raw body first — the HMAC covers the exact bytes.
	let raw;
	try {
		raw = await readBody(req);
	} catch {
		return json(res, 400, { error: "body_read_failed" });
	}

	// Auth: HMAC(timestamp + "\n" + rawBody), replay-bounded. Secret never sent.
	if (!verifySignature(req.headers["x-timestamp"], raw, req.headers["x-signature"])) {
		return json(res, 401, { error: "unauthorized" });
	}

	let spec;
	try {
		spec = JSON.parse(raw);
	} catch {
		return json(res, 400, { error: "invalid_json" });
	}
	if (!spec?.url || typeof spec.url !== "string") return json(res, 400, { error: "missing_url" });

	let target;
	try {
		target = await assertPublicTarget(spec.url);
	} catch (e) {
		return json(res, 400, { error: "blocked_target", detail: String(e.message || e) });
	}

	try {
		const fetchInit = {
			method: spec.method || "GET",
			headers: { ...DEFAULT_HEADERS, ...(spec.headers || {}) },
			body: spec.body,
			signal: AbortSignal.timeout(TIMEOUT_MS),
		};
		// "manual" lets the Worker's `redirects` fn trace the hop chain itself (single
		// 3xx back, unfollowed). Otherwise follow redirects the SSRF-safe way:
		// re-validate every hop's Location so a public URL can't 302 us into the LAN.
		const upstream = spec.redirect === "manual" ? await fetch(target, { ...fetchInit, redirect: "manual" }) : await fetchFollowingSafely(target, fetchInit);

		// Read up to MAX_BYTES so a huge page can't OOM the box.
		const reader = upstream.body?.getReader();
		const parts = [];
		let total = 0;
		if (reader) {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.length;
				if (total > MAX_BYTES) {
					await reader.cancel();
					break;
				}
				parts.push(Buffer.from(value));
			}
		}
		console.log(`${new Date().toISOString()} fetch ${target.host} -> ${upstream.status} ${total}b`);
		json(res, 200, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers: Object.fromEntries(upstream.headers),
			bytes: total,
			truncated: total > MAX_BYTES,
			...encodeBody(Buffer.concat(parts)),
		});
	} catch (e) {
		json(res, 502, { error: "upstream_failed", detail: String(e.message || e) });
	}
});

function main() {
	if (!SECRET || SECRET.length < 16) {
		console.error("Refusing to start: set PROXY_SECRET to a strong (>=16 char) secret.");
		process.exit(1);
	}
	server.listen(PORT, () => console.log(`tailscale fetch-proxy on :${PORT} (expose with: tailscale funnel ${PORT})`));
}

// Only bind a port when run as the entrypoint (`node server.mjs`); importing the
// module (tests) gets the helpers/handler without a listening socket or the
// process.exit secret guard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
