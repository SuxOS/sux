import { type Fn, fail, ok } from "../registry";

/** Fisher-Yates shuffle using crypto.getRandomValues (non-reproducible). */
function shuffle<T>(items: T[]): T[] {
	const out = items.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const buf = new Uint32Array(1);
		crypto.getRandomValues(buf);
		const j = buf[0] % (i + 1);
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

export const sample: Fn = {
	name: "sample",
	description:
		"Take a random sample of `n` items. mode: lines (default) samples text lines; json samples a JSON array. Selection uses crypto.getRandomValues, so results are NOT reproducible across calls. If n >= the population size, all items are returned (shuffled). Returns text (lines) or a JSON array (json).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data", "n"],
		properties: {
			data: { type: "string", description: "Text (lines mode) or a JSON array string (json mode)." },
			n: { type: "integer", minimum: 0, description: "Number of items to sample." },
			mode: { type: "string", enum: ["lines", "json"], default: "lines", description: "How to interpret `data`." },
		},
	},
	cacheable: false,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		const mode = String(args?.mode ?? "lines");
		const n = Number(args?.n);
		if (!Number.isInteger(n) || n < 0) return fail("`n` must be a non-negative integer.");
		if (mode !== "lines" && mode !== "json") return fail("mode must be 'lines' or 'json'.");

		if (mode === "lines") {
			const lines = data.split(/\r?\n/);
			const picked = shuffle(lines).slice(0, n);
			return ok(picked.join("\n"));
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(data);
		} catch (e) {
			return fail(`data is not valid JSON: ${String((e as Error).message ?? e)}`);
		}
		if (!Array.isArray(parsed)) return fail("json mode expects `data` to be a JSON array.");
		const picked = shuffle(parsed).slice(0, n);
		return ok(JSON.stringify(picked, null, 2));
	},
};
