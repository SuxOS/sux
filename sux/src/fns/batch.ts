import { hasAI, llm } from "../ai";
import { normalizeArgs, normalizeText } from "../normalize";
import { type Fn, fail, ok } from "../registry";

const CONCURRENCY = 8;

const MAX_CALLS = 100;

const NESTED_FANOUT_TOOLS = new Set(["pipe"]);
const MAX_NESTED_CALLS = 25;

const SEP = "\n\n---\n\n";

type ItemResult = { ok: boolean; text?: string; error?: string };

function dig(value: unknown, path: string): unknown {
	return path.split(".").reduce<unknown>((v, k) => (v != null && typeof v === "object" ? (v as any)[k] : undefined), value);
}

export function fillToken(value: unknown, token: string, replacement: unknown): unknown {
	if (typeof value === "string") {
		if (!value.includes(`{{${token}`)) return value;
		if (value.trim() === `{{${token}}}`) return replacement;
		const re = new RegExp(`\\{\\{${token}(?:\\.([\\w.]+))?\\}\\}`, "g");
		return value.replace(re, (_m, path) => {
			const got = path ? dig(replacement, path) : replacement;
			return got == null ? "" : typeof got === "string" ? got : JSON.stringify(got);
		});
	}
	if (Array.isArray(value)) return value.map((v) => fillToken(v, token, replacement));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = fillToken(v, token, replacement);
		return out;
	}
	return value;
}

export function pluckItems(items: string[], path?: string): unknown {
	if (!path) return items;
	return items
		.map((t) => {
			try {
				return dig(JSON.parse(t), path);
			} catch {
				return undefined;
			}
		})
		.filter((v) => v !== undefined);
}

export function fillItemsTokens(value: unknown, items: string[]): unknown {
	if (typeof value === "string") {
		const whole = value.trim().match(/^\{\{items(?:\.([\w.]+))?\}\}$/);
		if (whole) return pluckItems(items, whole[1]);
		if (!value.includes("{{items")) return value;
		return value.replace(/\{\{items(?:\.([\w.]+))?\}\}/g, (_m, p) => JSON.stringify(pluckItems(items, p)));
	}
	if (Array.isArray(value)) return value.map((v) => fillItemsTokens(v, items));
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value)) out[k] = fillItemsTokens(v, items);
		return out;
	}
	return value;
}

export const batch: Fn = {
	name: "batch",
	description:
		"Map-reduce one sux tool over many inputs. MAP two ways: `calls` (array of full arg objects, tool runs once each) OR `over` + `args` (map a template over a list — for each item in `over`, run `tool` with `args` where {{item}} / {{item.path}} is filled in, e.g. tool:pdf, over:[url1,url2], args:{url:'{{item}}'}). Map tool:pipe with {{item}}-templated steps to run a per-item PIPELINE — map(shrink(pdf()), URLs). Capped concurrency (~8), per-item failure tolerated. REDUCE the successful results server-side so you don't pull them all back into context: reduce = none (default) | concat (join text) | summarize (Workers-AI synthesis, falls back to concat). OR reduce_with = {tool, args} for a TOOL-based reduce — run a reducer once over the mapped outputs with {{items}} (JSON array of ok texts) or {{items.path}} (pluck a field from each) injected, e.g. reduce_with:{tool:'pdf',args:{operation:'merge',sources:'{{items.url}}'}} to merge mapped PDFs — shrink(reduce(pdf, URLs)). include_results (default true) → false drops the per-item array. Returns JSON { tool, results?, reduced? }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["tool"],
		properties: {
			tool: { type: "string", description: "Name of the sux tool to run for each call." },
			calls: {
				type: "array",
				items: { type: "object", additionalProperties: true },
				maxItems: 100,
				description: "Array of argument objects; the tool runs once per entry (max 100). Provide this OR over+args.",
			},
			over: {
				type: "array",
				items: {},
				maxItems: 100,
				description: "Items to map `args` over — each fills {{item}} / {{item.path}}. Lighter alternative to `calls` (e.g. over:[url1,url2], args:{url:'{{item}}'}).",
			},
			args: {
				type: "object",
				additionalProperties: true,
				description: "Per-item argument TEMPLATE used with `over`; {{item}} (whole) or {{item.path}} is substituted per item. Map tool:pipe with {{item}}-templated steps for a per-item pipeline.",
			},
			reduce_with: {
				type: "object",
				additionalProperties: false,
				required: ["tool"],
				properties: {
					tool: { type: "string", description: "Reducer tool, run once over the mapped outputs." },
					args: { type: "object", additionalProperties: true, description: "Reducer args; {{items}} = JSON array of the ok mapped texts (whole-value keeps it an array)." },
				},
				description: "TOOL-based reduce (overrides `reduce`): run a reducer once over the mapped outputs, e.g. reduce_with:{tool:'pdf',args:{operation:'merge',sources:'{{items}}'}}.",
			},
			reduce: {
				type: "string",
				enum: ["none", "concat", "summarize"],
				default: "none",
				description: "Reduce the successful results: none (return per-item results), concat (join their text), or summarize (synthesize one answer with Workers AI).",
			},
			include_results: {
				type: "boolean",
				default: true,
				description: "Include the per-item results array. Set false on a pure reduce to return just { tool, reduced }.",
			},
		},
	},
	cacheable: false,
	raw: true,
	run: async (env, args) => {
		const toolName = typeof args?.tool === "string" ? args.tool.trim() : "";
		if (!toolName) return fail("Provide a `tool` name.");

		let calls: unknown[];
		if (Array.isArray(args?.over)) {
			const tmpl = args?.args;
			if (tmpl == null || typeof tmpl !== "object" || Array.isArray(tmpl)) return fail("`over` requires an `args` template object (e.g. args:{url:'{{item}}'}).");
			calls = (args.over as unknown[]).map((item) => fillToken(tmpl, "item", item));
		} else if (Array.isArray(args?.calls)) {
			calls = args.calls;
		} else {
			return fail("Provide `calls` (array of arg objects) or `over` + `args` (template to map over).");
		}
		if (calls.length > MAX_CALLS) return fail(`Too many calls: ${calls.length} (max ${MAX_CALLS} per batch).`);

		if (NESTED_FANOUT_TOOLS.has(toolName) && calls.length > MAX_NESTED_CALLS) {
			return fail(`Too many calls for nested fan-out tool '${toolName}': ${calls.length} (max ${MAX_NESTED_CALLS} when mapping a fan-out tool).`);
		}
		const reduce = String(args?.reduce ?? "none");
		if (reduce !== "none" && reduce !== "concat" && reduce !== "summarize") return fail(`Unknown reduce '${reduce}'. Options: none, concat, summarize.`);
		const reduceWith = args?.reduce_with as { tool?: unknown; args?: unknown } | undefined;
		const hasReduceWith = reduceWith != null && typeof reduceWith === "object" && typeof reduceWith.tool === "string";
		const includeResults = args?.include_results !== false;

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

					const r = await target.run(env, target.raw ? callArgs : normalizeArgs(callArgs));
					const text = r.content?.[0]?.text ?? "";
					results[i] = r.isError ? { ok: false, error: text } : { ok: true, text: target.raw ? text : normalizeText(text) };
				} catch (e) {
					results[i] = { ok: false, error: String((e as Error)?.message ?? e) };
				}
			}
		}

		const pool = Math.min(CONCURRENCY, Math.max(1, calls.length));
		await Promise.all(Array.from({ length: pool }, () => worker()));

		if (hasReduceWith) {
			const rTool = String(reduceWith!.tool);
			if (rTool === "batch") return fail("reduce_with tool cannot be `batch`.");
			const rFound = FUNCTIONS.find((f) => f.name === rTool);
			if (!rFound) return fail(`reduce_with: unknown tool '${rTool}'.`);
			const items = results.filter((r) => r?.ok && r.text).map((r) => r.text as string);
			const filled = fillItemsTokens((reduceWith!.args as Record<string, unknown>) ?? {}, items) as Record<string, unknown>;
			try {
				const rr = await rFound.run(env, rFound.raw ? filled : normalizeArgs(filled));
				const text = rr.content?.[0]?.text ?? "";
				if (rr.isError) return fail(`reduce_with '${rTool}' failed: ${text}`);
				const reduced = rFound.raw ? text : normalizeText(text);
				const payload = includeResults ? { tool: toolName, results, reduced, reduced_with: rTool } : { tool: toolName, reduced, reduced_with: rTool };
				return ok(JSON.stringify(payload, null, 2));
			} catch (e) {
				return fail(`reduce_with '${rTool}' failed: ${String((e as Error)?.message ?? e)}`);
			}
		}

		if (reduce === "none") return ok(JSON.stringify({ tool: toolName, results }, null, 2));

		const okText = results.filter((r) => r?.ok && r.text).map((r) => r.text as string);
		const joined = okText.join(SEP);

		let reduced: string;
		if (reduce === "summarize" && hasAI(env)) {
			try {
				reduced = await llm(
					env,
					"Synthesize these results — each is the output of one tool call — into one concise combined answer. No preamble.",
					joined.slice(0, 24_000),
					512,
				);
			} catch (e) {

				reduced = `${joined}\n\n(summarize failed, returning concat: ${String((e as Error).message ?? e)})`;
			}
		} else if (reduce === "summarize") {

			reduced = `${joined}\n\n(summarize skipped: Workers AI binding not configured — returning concat)`;
		} else {
			reduced = joined;
		}

		const payload = includeResults ? { tool: toolName, results, reduced } : { tool: toolName, reduced };
		return ok(JSON.stringify(payload, null, 2));
	},
};
