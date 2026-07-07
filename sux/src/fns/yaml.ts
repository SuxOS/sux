import { type Fn, fail, ok } from "../registry";
import { toYaml } from "./_convert";

export const yaml: Fn = {
	name: "yaml",
	description: "Convert JSON to YAML (a practical common subset: scalars, nested maps, block sequences). Inverse of json(). No anchors/aliases or block scalars.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "JSON text to convert to YAML." },
		},
	},
	cacheable: true,
	ttl: 86400, // pure deterministic converter — same input always yields the same YAML
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("`data` is required.");
		try {
			return ok(toYaml(JSON.parse(data)));
		} catch (e) {
			return fail(`yaml failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
