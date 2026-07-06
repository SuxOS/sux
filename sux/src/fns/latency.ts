import { type Fn, fail, ok } from "../registry";
import { smartFetch } from "../proxy";

export const latency: Fn = {
	name: "latency",
	description:
		"Measure round-trip latency to a URL by timing HEAD requests through the residential proxy. samples default 3 (1-20). Returns JSON { url, samples, min_ms, max_ms, avg_ms }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["url"],
		properties: {
			url: { type: "string", description: "Absolute http(s) URL." },
			samples: { type: "number", default: 3, description: "How many probes to send (1-20)." },
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const url = String(args?.url ?? "");
		if (!/^https?:\/\//i.test(url)) return fail("url must be absolute http(s).");
		const samples = Math.min(20, Math.max(1, Math.trunc(Number(args?.samples ?? 3)) || 3));

		const times: number[] = [];
		for (let i = 0; i < samples; i++) {
			const t0 = Date.now();
			try {
				await smartFetch(env, url, { method: "HEAD" });
			} catch (e) {
				return fail(`Probe ${i + 1} failed: ${String((e as Error).message ?? e)}`);
			}
			times.push(Date.now() - t0);
		}

		const min_ms = Math.min(...times);
		const max_ms = Math.max(...times);
		const avg_ms = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
		return ok(JSON.stringify({ url, samples, min_ms, max_ms, avg_ms }, null, 2));
	},
};
