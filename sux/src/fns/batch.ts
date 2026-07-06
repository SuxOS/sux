import { type Fn, fail, ok } from "../registry";

// Broadcast: run one sux tool over many argument sets. FUNCTIONS is imported
// dynamically *inside* run() to avoid the static import cycle (index.ts imports
// this file). Concurrency is capped and per-item failures are tolerated so one
// bad call doesn't sink the batch.

const CONCURRENCY = 8;

type ItemResult = { ok: boolean; text?: string; error?: string };

export const batch: Fn = {
	name: "batch",
	description:
		"Broadcast one sux tool over many argument sets. tool: the tool name to invoke; calls: an array of argument objects (one per invocation). Runs with capped concurrency (~8), tolerating per-item failure. Returns JSON { tool, results } where each result is { ok, text } or { ok:false, error }. Fails if the tool is unknown.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["tool", "calls"],
		properties: {
			tool: { type: "string", description: "Name of the sux tool to run for each call." },
			calls: {
				type: "array",
				items: { type: "object", additionalProperties: true },
				description: "Array of argument objects; the tool runs once per entry.",
			},
		},
	},
	cacheable: false,
	run: async (env, args) => {
		const toolName = typeof args?.tool === "string" ? args.tool.trim() : "";
		if (!toolName) return fail("Provide a `tool` name.");
		if (!Array.isArray(args?.calls)) return fail("`calls` must be an array of argument objects.");
		const calls: unknown[] = args.calls;

		// Dynamic import breaks the static cycle (index.ts -> batch.ts -> index.ts).
		const { FUNCTIONS } = (await import("./index")) as { FUNCTIONS: Fn[] };
		if (toolName === "batch") return fail("Refusing to run `batch` recursively.");
		const found = FUNCTIONS.find((f) => f.name === toolName);
		if (!found) {
			const names = FUNCTIONS.map((f) => f.name).sort().join(", ");
			return fail(`Unknown tool '${toolName}'. Available: ${names}`);
		}
		const target: Fn = found;

		const results: ItemResult[] = new Array(calls.length);
		let next = 0;
		async function worker(): Promise<void> {
			for (;;) {
				const i = next++;
				if (i >= calls.length) return;
				const callArgs = calls[i];
				if (callArgs == null || typeof callArgs !== "object" || Array.isArray(callArgs)) {
					results[i] = { ok: false, error: "call args must be an object." };
					continue;
				}
				try {
					const r = await target.run(env, callArgs);
					const text = r.content?.[0]?.text ?? "";
					results[i] = r.isError ? { ok: false, error: text } : { ok: true, text };
				} catch (e) {
					results[i] = { ok: false, error: String((e as Error)?.message ?? e) };
				}
			}
		}

		const pool = Math.min(CONCURRENCY, Math.max(1, calls.length));
		await Promise.all(Array.from({ length: pool }, () => worker()));

		return ok(JSON.stringify({ tool: toolName, results }, null, 2));
	},
};
