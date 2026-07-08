import { hasAI, llm } from "../ai";
import { type Fn, failWith, ok, type RtEnv } from "../registry";

// AI text-restyler. Rewrites `text` into a target `style` and/or a learned
// preference `profile` (a distilled spec + a few-shot of writing samples kept in
// KV by the `preferences` fn), preserving meaning, names, facts, numbers, and
// links. The user's text is UNTRUSTED — it rides the guarded llm() so it's fenced
// as data (see ai.ts) and can't hijack the restyle instruction. Output is only the
// rewritten text, no preamble.

const KV_PREFIX = "sux:prefs:";

/** A stored preference profile (written by the `preferences` fn). All fields optional. */
type PrefProfile = {
	name?: string;
	distilled_spec?: string;
	examples?: Array<string | Record<string, unknown>>;
};

/** Pull the best voice-sample text out of one stored example (string or object). */
function exampleText(e: string | Record<string, unknown>): string {
	if (typeof e === "string") return e.trim();
	if (e && typeof e === "object") {
		const o = e as Record<string, unknown>;
		const pick = o.after ?? o.output ?? o.rewritten ?? o.text ?? o.example ?? o.sample;
		return String(pick ?? JSON.stringify(o)).trim();
	}
	return String(e).trim();
}

/**
 * Load a profile from KV and fold its distilled spec + up to ~3 examples into
 * system guidance lines. Returns [] if the profile is absent or unparseable — the
 * caller degrades gracefully (a bad/missing profile never fails the restyle).
 */
async function profileGuidance(env: RtEnv, profile: string): Promise<string[]> {
	let raw: string | null = null;
	try {
		raw = await env.OAUTH_KV.get(`${KV_PREFIX}${profile}`);
	} catch {
		return [];
	}
	if (!raw) return [];
	let p: PrefProfile;
	try {
		p = JSON.parse(raw) as PrefProfile;
	} catch {
		return [];
	}
	const lines: string[] = [];
	const spec = String(p?.distilled_spec ?? "").trim();
	if (spec) lines.push(`Learned voice profile "${profile}" — match this style specification:\n${spec}`);
	const examples = (Array.isArray(p?.examples) ? p.examples : [])
		.map(exampleText)
		.filter((s) => s.length > 0)
		.slice(0, 3);
	if (examples.length) {
		lines.push(`Reference samples written in the "${profile}" voice (match their tone and cadence, not their content):\n${examples.map((s, i) => `Sample ${i + 1}: ${s}`).join("\n")}`);
	}
	return lines;
}

export const voice: Fn = {
	name: "voice",
	cost: 2,
	description:
		"AI text-restyler. Rewrites `text` into a target `style` and/or a learned preference `profile`, preserving meaning, names, facts, numbers, and links — returns only the rewritten text, no preamble. " +
		"`style`: free-form — any descriptor works (common ones: professional, non-violent, brief, casual, academic, friendly, formal, plain, warm). " +
		"`profile`: name of a learned voice profile (see the `preferences` fn) whose distilled spec + example samples are folded in from KV; skipped gracefully if absent. " +
		"At least one of `style`/`profile` is required. `strength`: light (a gentle touch, keep most original phrasing) | strong (fully recast; default). `instructions`: optional extra guidance.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["text"],
		properties: {
			text: { type: "string", description: "The text to restyle." },
			style: { type: "string", description: "Target style — free-form (e.g. professional, non-violent, brief, casual, academic, friendly)." },
			profile: { type: "string", description: "Name of a learned voice profile to apply (see the `preferences` fn)." },
			strength: { type: "string", enum: ["light", "strong"], default: "strong", description: "light = gentle touch; strong = fully recast (default)." },
			instructions: { type: "string", description: "Optional extra guidance for the rewrite." },
		},
	},
	cacheable: true,
	ttl: 3600,
	run: async (env, args) => {
		if (!hasAI(env)) return failWith("not_configured", 'Workers AI binding not configured (add "ai" to wrangler).');

		const text = String(args?.text ?? "");
		const style = String(args?.style ?? "").trim();
		const profile = String(args?.profile ?? "").trim();
		const strength = args?.strength === "light" ? "light" : "strong";
		const instructions = String(args?.instructions ?? "").trim();

		if (!text.trim()) return failWith("bad_input", "Provide `text` to restyle.");
		// The restyle needs a target: a style, a profile, or both. Neither is a no-op.
		if (!style && !profile) return failWith("bad_input", "Provide a `style` and/or a `profile` — at least one is required.");

		try {
			// Fold the learned profile (if any) into system guidance. Absent/unparseable
			// profiles yield [] and are silently skipped — the restyle proceeds on style alone.
			const profileLines = profile ? await profileGuidance(env, profile) : [];

			const guidance: string[] = [];
			if (style) guidance.push(`Target style: ${style}.`);
			guidance.push(...profileLines);
			if (instructions) guidance.push(`Additional guidance: ${instructions}`);
			// A profile named but not found leaves only a placeholder line so the model
			// still restyles on whatever style was given (or, if none, does a faithful copy).
			if (profile && profileLines.length === 0) guidance.push(`(Voice profile "${profile}" was not found — restyle on the style/guidance above.)`);

			const touch =
				strength === "light"
					? "Apply a light touch: adjust tone and word choice toward the target while keeping most of the original phrasing and structure."
					: "Fully recast the text in the target voice: rephrase freely so it reads as if natively written that way.";

			const system = [
				"You are a precise text restyler. Rewrite the given text to match the target voice below.",
				touch,
				"Absolutely preserve the original meaning, all names, facts, numbers, dates, quotes, and links/URLs verbatim. Do not add, remove, or invent information.",
				"Output ONLY the rewritten text — no preamble, no quotes, no explanation, no labels.",
				"",
				...guidance,
			].join("\n");

			// text is the UNTRUSTED user content — passed as the user arg so guarded llm()
			// fences it in <<<DATA>>> markers; it can never dislodge the system restyle spec.
			const maxTokens = Math.min(2048, Math.max(256, Math.ceil(text.length / 2)));
			const out = await llm(env, system, text.slice(0, 24_000), maxTokens, "restyle");
			if (!out?.trim()) return failWith("upstream_error", "voice produced an empty result — retry.");
			return ok(out);
		} catch (e) {
			return failWith("upstream_error", `voice failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
