import { runInline, type Op } from "@suxos/lib";
import { type Fn, failWith, ok, type RtEnv } from "../registry";
import { makeCaps } from "../op-engine/caps";
import { registry } from "../op-engine/registry";
import { errMsg, oj } from "./_util";

export type RunMode = "inline" | "durable" | "auto";

// `auto` routes to the durable runtime exactly when the op needs it: a fan-out (`map`,
// to run items concurrently under retries) or an `ask` (a human pause that must survive
// isolate eviction). A flat pure/effect pipe has neither, so it runs inline in-request
// — cheap, synchronous, no Workflow instance. Recurses through `pipe` since either can nest.
function needsDurable(n: Op): boolean {
	if (n.tag === "map" || n.tag === "ask") return true;
	if (n.tag === "pipe") return n.steps.some(needsDurable);
	return false;
}

// Every `ask` node's prompt in tree order — the `answer` action's auto-resolve path:
// an op with exactly one `ask` needs no explicit `prompt` from the caller, since there
// is only one gate it could mean. Recurses through `pipe` only, mirroring needsDurable
// (today's op trees never nest `ask` inside `map`).
function askPrompts(n: Op): string[] {
	if (n.tag === "ask") return [n.prompt];
	if (n.tag === "pipe") return n.steps.flatMap(askPrompts);
	return [];
}

/**
 * Run a registered op by id. INLINE (forced, or `auto` over a simple tree) interprets
 * the op in-request and returns its OUTPUT. DURABLE (forced, or `auto` over a tree with
 * fan-out/ask) starts an OpWorkflow instance and returns `{ instanceId }` — the caller
 * polls status and delivers `ask` answers to the instance out of band. Throws on an
 * unknown op, or on durable mode without the OP_WORKFLOW binding.
 */
export async function runVerb({ op: opId, input, mode = "auto" }: { op: string; input: any; mode?: RunMode }, env: RtEnv): Promise<any> {
	const build = registry[opId];
	if (!build) throw new Error(`unknown op: ${opId}`);
	const tree = build();
	const durable = mode === "durable" || (mode === "auto" && needsDurable(tree));
	if (!durable) return runInline(tree, input, makeCaps(env));
	if (!env.OP_WORKFLOW) throw new Error("run: durable mode needs the OP_WORKFLOW binding.");
	const instance = await env.OP_WORKFLOW.create({ params: { opId, input } });
	return { instanceId: instance.id };
}

/**
 * Poll a durable instance's current state — `queued|running|paused|errored|
 * terminated|complete|waiting|waitingForPause`, plus `output` once complete and
 * `error` if it failed. Throws without the OP_WORKFLOW binding, or if `id` doesn't
 * name a live instance.
 */
export async function statusVerb(id: string, env: RtEnv): Promise<Record<string, unknown>> {
	if (!env.OP_WORKFLOW) throw new Error("run: status needs the OP_WORKFLOW binding.");
	const instance = await env.OP_WORKFLOW.get(id);
	return { id, ...(await instance.status()) };
}

/**
 * Deliver an answer to a paused `ask` gate. The event `type` an `ask` node waits on
 * is `ask:${prompt}` (durable.ts), so this needs either an explicit `prompt` or the
 * `opId` whose tree has exactly one `ask` (auto-resolved via askPrompts). `answer` is
 * the event payload delivered to the resumed run (any JSON; default `{}`).
 */
export async function answerVerb({ id, opId, prompt, answer }: { id: string; opId?: string; prompt?: string; answer?: unknown }, env: RtEnv): Promise<{ id: string; type: string }> {
	if (!env.OP_WORKFLOW) throw new Error("run: answer needs the OP_WORKFLOW binding.");
	let p = prompt;
	if (!p) {
		if (!opId) throw new Error("run: answer needs a `prompt`, or an `op` to auto-resolve it when that op has exactly one `ask` gate.");
		const build = registry[opId];
		if (!build) throw new Error(`unknown op: ${opId}`);
		const prompts = askPrompts(build());
		if (prompts.length !== 1)
			throw new Error(`run: answer could not auto-resolve a single ask gate for '${opId}' (found ${prompts.length}); pass \`prompt\` explicitly.`);
		p = prompts[0];
	}
	const instance = await env.OP_WORKFLOW.get(id);
	const type = `ask:${p}`;
	await instance.sendEvent({ type, payload: answer ?? {} });
	return { id, type };
}

/** Terminate a running instance. `rollback: true` runs registered rollback handlers first. */
export async function cancelVerb(id: string, env: RtEnv, opts?: { rollback?: boolean }): Promise<{ id: string; cancelled: true }> {
	if (!env.OP_WORKFLOW) throw new Error("run: cancel needs the OP_WORKFLOW binding.");
	const instance = await env.OP_WORKFLOW.get(id);
	await instance.terminate(opts?.rollback ? { rollback: true } : undefined);
	return { id, cancelled: true };
}

export const run: Fn = {
	name: "run",
	surface: "front",
	// A run has side effects (op leaves, sinks) and starting a Workflow is not idempotent,
	// so it must never be served from cache.
	cacheable: false,
	description:
		"Run a composable op (a named suxlib Op tree) by id, and control any durable instance it starts. {action}: start (default) | status | answer | cancel. start — {op}: the registered op id (call with a bad id to see the list; MVP ships `echo`). {input}: the op's input value (any JSON). {mode}: auto (default — inline for a simple pure/effect pipe, durable when the op fans out (map) or pauses for a human (ask)) | inline (force in-request; returns the op's output) | durable (force a Workflow; returns {instanceId} to poll). status — {id}: the instanceId from a durable start; returns the instance's state (queued|running|paused|errored|terminated|complete|waiting|waitingForPause) plus `output` once complete or `error` if it failed. answer — {id} + {prompt} (or {op}, auto-resolved when that op has exactly one `ask` gate) + optional {answer} payload: delivers the event an `ask` node is paused on, releasing it. cancel — {id} + optional {rollback}: terminates the instance, running rollback handlers first if requested. The durable runtime persists every step, so a run survives isolate eviction, retries, and multi-day approval pauses. Durable mode (start/status/answer/cancel) needs the OP_WORKFLOW binding.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			action: {
				type: "string",
				enum: ["start", "status", "answer", "cancel"],
				description: "start (default): run an op. status: poll a durable instance. answer: resolve a paused `ask` gate. cancel: terminate a running instance.",
			},
			op: { type: "string", description: "start: registered op id to run (e.g. `echo`); an unknown id returns the known-ops list. answer: optional, to auto-resolve `prompt` when the op has exactly one `ask` gate." },
			input: { description: "start: input value passed to the op tree (any JSON: string, object, array, …)." },
			mode: {
				type: "string",
				enum: ["inline", "durable", "auto"],
				description: "start: auto (default): inline for a simple op, durable when it fans out or asks. inline: force in-request, return output. durable: force a Workflow, return {instanceId}.",
			},
			id: { type: "string", description: "status/answer/cancel: the durable instanceId returned by a durable start." },
			prompt: { type: "string", description: "answer: the paused `ask` node's exact prompt text (the event type is `ask:<prompt>`). Omit to auto-resolve from `op` when it has exactly one `ask` gate." },
			answer: { description: "answer: the payload delivered to the paused gate (any JSON; default `{}`)." },
			rollback: { type: "boolean", description: "cancel: run the instance's registered rollback handlers before terminating (default false)." },
		},
	},
	annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
	run: async (env, a) => {
		const action = a?.action ? String(a.action) : "start";
		if (action !== "start" && action !== "status" && action !== "answer" && action !== "cancel")
			return failWith("bad_input", `run: action must be start|status|answer|cancel (got '${action}').`);
		try {
			if (action === "status") {
				const id = a?.id ? String(a.id) : "";
				if (!id) return failWith("bad_input", "run status requires an `id` (the instanceId from a durable start).");
				return ok(oj(await statusVerb(id, env)));
			}
			if (action === "answer") {
				const id = a?.id ? String(a.id) : "";
				if (!id) return failWith("bad_input", "run answer requires an `id` (the instanceId).");
				const opId = a?.op ? String(a.op) : undefined;
				if (opId && !registry[opId]) return failWith("not_found", `run: unknown op '${opId}'. Known ops: ${Object.keys(registry).join(", ") || "(none)"}.`);
				const prompt = a?.prompt ? String(a.prompt) : undefined;
				return ok(oj(await answerVerb({ id, opId, prompt, answer: a?.answer }, env)));
			}
			if (action === "cancel") {
				const id = a?.id ? String(a.id) : "";
				if (!id) return failWith("bad_input", "run cancel requires an `id` (the instanceId).");
				return ok(oj(await cancelVerb(id, env, { rollback: a?.rollback === true })));
			}
			const opId = a?.op ? String(a.op) : "";
			if (!opId) return failWith("bad_input", "run requires an `op` (a registered op id).");
			if (!registry[opId]) return failWith("not_found", `run: unknown op '${opId}'. Known ops: ${Object.keys(registry).join(", ") || "(none)"}.`);
			const mode = a?.mode ? String(a.mode) : "auto";
			if (mode !== "inline" && mode !== "durable" && mode !== "auto") return failWith("bad_input", `run: mode must be inline|durable|auto (got '${mode}').`);
			const res = await runVerb({ op: opId, input: a?.input, mode }, env);
			return ok(oj(res));
		} catch (e) {
			return failWith("upstream_error", `run ${action} failed: ${errMsg(e)}`);
		}
	},
};
