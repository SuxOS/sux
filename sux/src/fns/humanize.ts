import { type Fn, fail, ok } from "../registry";

// Human-friendly number formatting: byte sizes, millisecond durations, grouped
// integers, and percentages.

function humanizeBytes(n: number, base: 1000 | 1024): string {
	const units = base === 1024 ? ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] : ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
	const sign = n < 0 ? "-" : "";
	let v = Math.abs(n);
	let i = 0;
	while (v >= base && i < units.length - 1) {
		v /= base;
		i++;
	}
	// Whole bytes stay integer; scaled values get up to 2 significant decimals.
	const str = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2).replace(/\.?0+$/, "");
	return `${sign}${str} ${units[i]}`;
}

function humanizeDuration(ms: number): string {
	const sign = ms < 0 ? "-" : "";
	let rem = Math.abs(ms);
	if (rem < 1000) return `${sign}${Math.round(rem)}ms`;
	const parts: string[] = [];
	const units: Array<[string, number]> = [
		["d", 86400000],
		["h", 3600000],
		["m", 60000],
		["s", 1000],
	];
	for (const [label, size] of units) {
		if (rem >= size) {
			const q = Math.floor(rem / size);
			rem -= q * size;
			parts.push(`${q}${label}`);
		}
	}
	// Keep it tight: at most the two most-significant components.
	return sign + parts.slice(0, 2).join(" ");
}

function humanizeNumber(n: number): string {
	if (!Number.isFinite(n)) return String(n);
	const sign = n < 0 ? "-" : "";
	const abs = Math.abs(n);
	const [int, frac] = String(abs).split(".");
	const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
	return sign + (frac ? `${grouped}.${frac}` : grouped);
}

export const humanize: Fn = {
	name: "humanize",
	description:
		"Human-friendly formatting of a number. kind (required): bytes (KB/MB/GiB; `base` 1000 default | 1024) | duration_ms (e.g. '1h 2m') | number (thousands separators) | percent (value*100 with a % sign). Returns the formatted string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["value", "kind"],
		properties: {
			value: { type: "number", description: "Numeric value to format." },
			kind: { type: "string", enum: ["bytes", "duration_ms", "number", "percent"], description: "How to interpret and format the value." },
			base: { type: "integer", enum: [1000, 1024], description: "Byte scaling base (kind=bytes only).", default: 1000 },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const value = args?.value;
		if (typeof value !== "number" || !Number.isFinite(value)) return fail("`value` must be a finite number.");
		const kind = args?.kind;
		if (kind !== "bytes" && kind !== "duration_ms" && kind !== "number" && kind !== "percent")
			return fail("kind must be one of: bytes, duration_ms, number, percent");

		if (kind === "bytes") {
			const base = args?.base === 1024 ? 1024 : 1000;
			return ok(humanizeBytes(value, base));
		}
		if (kind === "duration_ms") return ok(humanizeDuration(value));
		if (kind === "number") return ok(humanizeNumber(value));
		const pct = value * 100;
		const str = Number.isInteger(pct) ? String(pct) : pct.toFixed(2).replace(/\.?0+$/, "");
		return ok(`${str}%`);
	},
};
