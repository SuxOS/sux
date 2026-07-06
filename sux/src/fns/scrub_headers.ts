import { type Fn, fail, ok } from "../registry";

// Strip tracking / fingerprinting / auth headers from a headers object before
// logging, forwarding, or sharing it. Matching is case-insensitive on the
// header name; both an exact denylist and a couple of prefix rules are applied.

const DENY = new Set(
	[
		"cookie",
		"set-cookie",
		"authorization",
		"proxy-authorization",
		"user-agent",
		"referer",
		"referrer",
		"via",
		"x-real-ip",
		"x-client-ip",
		"cf-connecting-ip",
		"true-client-ip",
		"forwarded",
		"dnt",
		"x-request-id",
		"x-amzn-trace-id",
		"x-datadog-trace-id",
		"x-datadog-parent-id",
		"traceparent",
		"tracestate",
		"x-google-analytics",
		"x-ga",
		"x-fb-pixel",
		"x-mixpanel",
		"x-segment-id",
	].map((h) => h.toLowerCase()),
);

// Prefix rules: any header whose lowercased name starts with one of these is dropped.
const DENY_PREFIXES = ["x-forwarded-", "x-amz-cf-", "x-newrelic-"];

function shouldDrop(name: string): boolean {
	const lower = name.toLowerCase();
	if (DENY.has(lower)) return true;
	return DENY_PREFIXES.some((p) => lower.startsWith(p));
}

export const scrub_headers: Fn = {
	name: "scrub_headers",
	description:
		"Strip tracking, fingerprinting, and auth headers from a headers object: removes cookie/set-cookie, authorization, user-agent, referer, x-forwarded-*, via, x-real-ip and common analytics/trace headers (case-insensitive). Returns JSON { scrubbed, removed } where scrubbed is the surviving headers and removed lists the dropped header names.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["headers"],
		properties: {
			headers: { type: "object", description: "Header name → value map to scrub.", additionalProperties: true },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const headers = args?.headers;
		if (headers == null || typeof headers !== "object" || Array.isArray(headers)) {
			return fail("`headers` must be an object mapping header names to values.");
		}

		const scrubbed: Record<string, unknown> = {};
		const removed: string[] = [];
		for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
			if (shouldDrop(name)) removed.push(name);
			else scrubbed[name] = value;
		}

		return ok(JSON.stringify({ scrubbed, removed }, null, 2));
	},
};
