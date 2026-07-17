import { test, expect } from "vitest";
import { answerVerb, cancelVerb, runVerb, statusVerb } from "./run.js";

// The inline path needs no bindings (echo is a pure leaf), so an empty env exercises
// the whole runVerb → runInline → op path in plain node vitest.
test("run executes a registered op inline", async () => {
	const res = await runVerb({ op: "echo", input: "hi", mode: "inline" }, {} as any);
	expect(res).toBe("hi");
});

test("run auto-routes a simple (no fan-out / no ask) op to the inline path", async () => {
	const res = await runVerb({ op: "echo", input: { a: 1 }, mode: "auto" }, {} as any);
	expect(res).toEqual({ a: 1 });
});

test("run rejects an unknown op", async () => {
	await expect(runVerb({ op: "nope", input: 1, mode: "inline" }, {} as any)).rejects.toThrow(/unknown op/);
});

// A fake OP_WORKFLOW binding — records the id `get` was called with and hands back
// whatever instance stub the test provides, exercising status/answer/cancel exactly
// as the real Workflow<T>.get(id) → WorkflowInstance seam is shaped.
const fakeWorkflow = (instance: any) => ({
	get: async (_id: string) => instance,
});

test("run status polls the instance and folds `id` into its status()", async () => {
	const env = { OP_WORKFLOW: fakeWorkflow({ status: async () => ({ status: "complete", output: { ok: true } }) }) } as any;
	const res = await statusVerb("abc123", env);
	expect(res).toEqual({ id: "abc123", status: "complete", output: { ok: true } });
});

test("run status throws without the OP_WORKFLOW binding", async () => {
	await expect(statusVerb("abc123", {} as any)).rejects.toThrow(/OP_WORKFLOW/);
});

test("run answer sends ask:<prompt> with the given payload when `prompt` is explicit", async () => {
	const sent: any[] = [];
	const env = { OP_WORKFLOW: fakeWorkflow({ sendEvent: async (e: any) => sent.push(e) }) } as any;
	const res = await answerVerb({ id: "abc123", prompt: "ok?", answer: { approve: true } }, env);
	expect(res).toEqual({ id: "abc123", type: "ask:ok?" });
	expect(sent).toEqual([{ type: "ask:ok?", payload: { approve: true } }]);
});

test("run answer auto-resolves the prompt from `op` when it has exactly one ask gate, defaulting payload to {}", async () => {
	const sent: any[] = [];
	const env = { OP_WORKFLOW: fakeWorkflow({ sendEvent: async (e: any) => sent.push(e) }) } as any;
	const res = await answerVerb({ id: "abc123", opId: "assimilate-pdfs" }, env);
	expect(res).toEqual({ id: "abc123", type: "ask:review master?" });
	expect(sent).toEqual([{ type: "ask:review master?", payload: {} }]);
});

test("run answer rejects when it can't auto-resolve a single ask gate (no prompt, no ask nodes)", async () => {
	const env = { OP_WORKFLOW: fakeWorkflow({ sendEvent: async () => {} }) } as any;
	await expect(answerVerb({ id: "abc123", opId: "echo" }, env)).rejects.toThrow(/could not auto-resolve/);
});

test("run answer rejects with neither `prompt` nor `op`", async () => {
	const env = { OP_WORKFLOW: fakeWorkflow({ sendEvent: async () => {} }) } as any;
	await expect(answerVerb({ id: "abc123" }, env)).rejects.toThrow(/needs a `prompt`/);
});

test("run cancel terminates the instance, passing rollback through only when requested", async () => {
	const calls: any[] = [];
	const env = { OP_WORKFLOW: fakeWorkflow({ terminate: async (opts?: any) => calls.push(opts) }) } as any;
	expect(await cancelVerb("abc123", env)).toEqual({ id: "abc123", cancelled: true });
	expect(await cancelVerb("abc123", env, { rollback: true })).toEqual({ id: "abc123", cancelled: true });
	expect(calls).toEqual([undefined, { rollback: true }]);
});
