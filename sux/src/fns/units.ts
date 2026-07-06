import { type Fn, fail, ok } from "../registry";

// Unit conversion across dimensions. Each non-temperature unit is stored as a
// factor to a canonical base unit; conversion is value * from / to. Temperature
// is affine (offsets) so it gets its own path.

type Dim = "length" | "mass" | "volume" | "time" | "speed" | "data";

// Base units: metre, gram, litre, second, metre/second, byte.
const FACTORS: Record<string, { dim: Dim; f: number }> = {
	// length (base: metre)
	nm: { dim: "length", f: 1e-9 },
	um: { dim: "length", f: 1e-6 },
	mm: { dim: "length", f: 1e-3 },
	cm: { dim: "length", f: 1e-2 },
	m: { dim: "length", f: 1 },
	km: { dim: "length", f: 1000 },
	in: { dim: "length", f: 0.0254 },
	ft: { dim: "length", f: 0.3048 },
	yd: { dim: "length", f: 0.9144 },
	mi: { dim: "length", f: 1609.344 },
	nmi: { dim: "length", f: 1852 },
	// mass (base: gram)
	mg: { dim: "mass", f: 1e-3 },
	g: { dim: "mass", f: 1 },
	kg: { dim: "mass", f: 1000 },
	t: { dim: "mass", f: 1e6 },
	oz: { dim: "mass", f: 28.349523125 },
	lb: { dim: "mass", f: 453.59237 },
	st: { dim: "mass", f: 6350.29318 },
	// volume (base: litre)
	ml: { dim: "volume", f: 1e-3 },
	l: { dim: "volume", f: 1 },
	tsp: { dim: "volume", f: 0.00492892159375 },
	tbsp: { dim: "volume", f: 0.01478676478125 },
	floz: { dim: "volume", f: 0.0295735295625 },
	cup: { dim: "volume", f: 0.2365882365 },
	pt: { dim: "volume", f: 0.473176473 },
	qt: { dim: "volume", f: 0.946352946 },
	gal: { dim: "volume", f: 3.785411784 },
	// time (base: second)
	ms: { dim: "time", f: 1e-3 },
	s: { dim: "time", f: 1 },
	min: { dim: "time", f: 60 },
	h: { dim: "time", f: 3600 },
	day: { dim: "time", f: 86400 },
	week: { dim: "time", f: 604800 },
	year: { dim: "time", f: 31557600 }, // Julian year
	// speed (base: m/s)
	mps: { dim: "speed", f: 1 },
	kph: { dim: "speed", f: 1000 / 3600 },
	mph: { dim: "speed", f: 1609.344 / 3600 },
	fps: { dim: "speed", f: 0.3048 },
	knot: { dim: "speed", f: 1852 / 3600 },
	// data (base: byte). Decimal (KB) and binary (KiB) both provided.
	bit: { dim: "data", f: 1 / 8 },
	byte: { dim: "data", f: 1 },
	b: { dim: "data", f: 1 },
	kb: { dim: "data", f: 1e3 },
	mb: { dim: "data", f: 1e6 },
	gb: { dim: "data", f: 1e9 },
	tb: { dim: "data", f: 1e12 },
	pb: { dim: "data", f: 1e15 },
	kib: { dim: "data", f: 1024 },
	mib: { dim: "data", f: 1024 ** 2 },
	gib: { dim: "data", f: 1024 ** 3 },
	tib: { dim: "data", f: 1024 ** 4 },
	pib: { dim: "data", f: 1024 ** 5 },
};

// Aliases -> canonical key (all lower-case).
const ALIAS: Record<string, string> = {
	metre: "m", meter: "m", metres: "m", meters: "m", kilometre: "km", kilometer: "km", kilometres: "km", kilometers: "km",
	centimetre: "cm", centimeter: "cm", millimetre: "mm", millimeter: "mm", micrometre: "um", micrometer: "um", nanometre: "nm", nanometer: "nm",
	inch: "in", inches: "in", foot: "ft", feet: "ft", yard: "yd", yards: "yd", mile: "mi", miles: "mi", "nautical-mile": "nmi",
	gram: "g", grams: "g", kilogram: "kg", kilograms: "kg", milligram: "mg", milligrams: "mg", tonne: "t", tonnes: "t", ton: "t",
	ounce: "oz", ounces: "oz", pound: "lb", pounds: "lb", lbs: "lb", stone: "st",
	litre: "l", liter: "l", litres: "l", liters: "l", millilitre: "ml", milliliter: "ml", teaspoon: "tsp", tablespoon: "tbsp",
	"fluid-ounce": "floz", "fl-oz": "floz", cups: "cup", pint: "pt", pints: "pt", quart: "qt", quarts: "qt", gallon: "gal", gallons: "gal",
	millisecond: "ms", milliseconds: "ms", sec: "s", secs: "s", second: "s", seconds: "s", minute: "min", minutes: "min", mins: "min",
	hour: "h", hours: "h", hr: "h", hrs: "h", days: "day", weeks: "week", years: "year", yr: "year", yrs: "year",
	"m/s": "mps", "km/h": "kph", "km/hr": "kph", "mi/h": "mph", "ft/s": "fps", knots: "knot", kn: "knot", kt: "knot",
	bytes: "byte", bits: "bit", kilobyte: "kb", kilobytes: "kb", megabyte: "mb", megabytes: "mb", gigabyte: "gb", gigabytes: "gb",
	terabyte: "tb", terabytes: "tb", petabyte: "pb", petabytes: "pb",
	kibibyte: "kib", mebibyte: "mib", gibibyte: "gib", tebibyte: "tib", pebibyte: "pib",
};

const TEMP: Record<string, "C" | "F" | "K"> = {
	c: "C", celsius: "C", centigrade: "C", "°c": "C",
	f: "F", fahrenheit: "F", "°f": "F",
	k: "K", kelvin: "K",
};

function norm(u: string): string {
	const key = u.trim().toLowerCase();
	return ALIAS[key] ?? key;
}

function toCelsius(v: number, unit: "C" | "F" | "K"): number {
	if (unit === "C") return v;
	if (unit === "F") return (v - 32) * (5 / 9);
	return v - 273.15;
}
function fromCelsius(c: number, unit: "C" | "F" | "K"): number {
	if (unit === "C") return c;
	if (unit === "F") return c * (9 / 5) + 32;
	return c + 273.15;
}

export const units: Fn = {
	name: "units",
	description:
		"Convert a value between units of the same dimension: length, mass, volume, temperature (C/F/K), data (bytes/KB/MB/GB and KiB/MiB/GiB…), time, and speed. Accepts common aliases (e.g. 'miles', 'km/h', 'kilograms'). Returns JSON { value, from, to, result }. Fails on incompatible dimensions.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["value", "from", "to"],
		properties: {
			value: { type: "number", description: "Numeric amount to convert." },
			from: { type: "string", description: "Source unit (e.g. 'km', 'lb', 'C', 'GiB', 'mph')." },
			to: { type: "string", description: "Target unit of the same dimension." },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const value = args?.value;
		if (typeof value !== "number" || !Number.isFinite(value)) return fail("`value` must be a finite number.");
		if (typeof args?.from !== "string" || typeof args?.to !== "string") return fail("Provide string `from` and `to` units.");

		const fromRaw = args.from.trim().toLowerCase();
		const toRaw = args.to.trim().toLowerCase();

		// Temperature path (affine).
		const tFrom = TEMP[fromRaw];
		const tTo = TEMP[toRaw];
		if (tFrom || tTo) {
			if (!tFrom || !tTo) return fail(`Cannot convert between temperature and a non-temperature unit (${args.from} → ${args.to}).`);
			const result = fromCelsius(toCelsius(value, tFrom), tTo);
			return ok(JSON.stringify({ value, from: args.from, to: args.to, result }, null, 2));
		}

		const from = norm(fromRaw);
		const to = norm(toRaw);
		const f = FACTORS[from];
		const t = FACTORS[to];
		if (!f) return fail(`Unknown unit '${args.from}'.`);
		if (!t) return fail(`Unknown unit '${args.to}'.`);
		if (f.dim !== t.dim) return fail(`Incompatible dimensions: '${args.from}' is ${f.dim}, '${args.to}' is ${t.dim}.`);

		const result = (value * f.f) / t.f;
		return ok(JSON.stringify({ value, from: args.from, to: args.to, result }, null, 2));
	},
};
