import { type Fn, fail, ok } from "../registry";

// Parse / format / shift a datetime using the Date global. Accepts ISO strings,
// epoch seconds or milliseconds, and common date strings the Date parser groks.
// All output is UTC to stay deterministic across runtimes.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Parse `input` into a Date, or null. Numbers/numeric strings are epoch (s vs ms by magnitude). */
function parseInput(input: unknown): Date | null {
	if (typeof input === "number" && Number.isFinite(input)) return epochToDate(input);
	if (typeof input !== "string") return null;
	const s = input.trim();
	if (!s) return null;
	// Pure integer (optionally negative) → epoch seconds or ms.
	if (/^-?\d+$/.test(s)) return epochToDate(Number(s));
	const d = new Date(s);
	return Number.isNaN(d.getTime()) ? null : d;
}

/** Heuristic: values with |n| >= 1e12 are milliseconds, else seconds. */
function epochToDate(n: number): Date {
	const ms = Math.abs(n) >= 1e12 ? n : n * 1000;
	const d = new Date(ms);
	return d;
}

/** Parse a shift like "+3d", "-2h", "90m", "+45s". Returns ms delta or null. */
function parseShift(add: string): number | null {
	const m = /^\s*([+-]?)(\d+(?:\.\d+)?)\s*(d|h|m|min|s|sec)\s*$/i.exec(add);
	if (!m) return null;
	const sign = m[1] === "-" ? -1 : 1;
	const n = Number(m[2]);
	const unit = m[3].toLowerCase();
	const per: Record<string, number> = { d: 86400000, h: 3600000, m: 60000, min: 60000, s: 1000, sec: 1000 };
	return sign * n * per[unit];
}

function components(d: Date) {
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
		weekday: WEEKDAYS[d.getUTCDay()],
	};
}

export const datetime: Fn = {
	name: "datetime",
	description:
		"Parse, format and shift a datetime (UTC). input: ISO 8601 string, epoch seconds/ms, or a common date string. add (optional): a shift like '+3d', '-2h', '90m', '+45s' (days/hours/min/sec). format: iso (default) | epoch | components. Returns JSON { iso, epoch_ms, utc:{year,month,day,hour,minute,second,weekday} } plus a `shifted` block when `add` is given.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["input"],
		properties: {
			input: { type: ["string", "number"], description: "ISO string, epoch seconds/ms, or common date." },
			add: { type: "string", description: "Optional shift, e.g. '+3d', '-2h', '15min', '30s'." },
			format: { type: "string", enum: ["iso", "epoch", "components"], default: "iso", description: "Emphasis of the response (all fields are always included)." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const base = parseInput(args?.input);
		if (!base) return fail("Could not parse `input`. Provide an ISO string, epoch seconds/ms, or a recognizable date.");

		const format = args?.format ?? "iso";
		if (format !== undefined && !["iso", "epoch", "components"].includes(format)) {
			return fail("`format` must be one of: iso, epoch, components.");
		}

		const out: Record<string, unknown> = {
			iso: base.toISOString(),
			epoch_ms: base.getTime(),
			utc: components(base),
		};

		if (args?.add !== undefined) {
			if (typeof args.add !== "string") return fail("`add` must be a string like '+3d' or '-2h'.");
			const delta = parseShift(args.add);
			if (delta === null) return fail(`Could not parse shift '${args.add}'. Use forms like '+3d', '-2h', '15min', '30s'.`);
			const shifted = new Date(base.getTime() + delta);
			out.shifted = { iso: shifted.toISOString(), epoch_ms: shifted.getTime(), utc: components(shifted) };
		}

		out.format = format;
		return ok(JSON.stringify(out, null, 2));
	},
};
