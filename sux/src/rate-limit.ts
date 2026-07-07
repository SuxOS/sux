import { FUNCTIONS } from "./fns";
import type { JsonRpc } from "./mcp-util";
import { findFn, type RtEnv } from "./registry";

const rateLimited = (): Response =>
	new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "10" } });

export function extraCost(name: string): number {
	const fn = findFn(FUNCTIONS, name);
	return Math.max(0, (fn?.cost ?? 1) - 1);
}

export async function weightedRateLimit(env: RtEnv, login: string, rpc: JsonRpc | undefined): Promise<Response | null> {
	if (!env.MCP_RATE_LIMITER || rpc?.method !== "tools/call") return null;
	const extra = extraCost(String(rpc.params?.name ?? ""));
	for (let i = 0; i < extra; i++) {
		const { success } = await env.MCP_RATE_LIMITER.limit({ key: login });
		if (!success) return rateLimited();
	}
	return null;
}
