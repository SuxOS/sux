import { type Fn, fail, ok } from "../registry";

// Validate a value against a named format OR a minimal JSON-Schema-ish shape.
// Pure — no network. Formats return valid/errors; schema validation walks a
// small subset (type, required[], properties{type}).

const FORMATS = ["email", "url", "uuid", "ipv4", "ipv6", "json", "credit_card", "gtin", "iso_date"] as const;
type Format = (typeof FORMATS)[number];

/** Luhn (credit cards). */
function luhnOk(digits: string): boolean {
	if (!/^\d{13,19}$/.test(digits)) return false;
	let sum = 0;
	let alt = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (alt) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		alt = !alt;
	}
	return sum % 10 === 0;
}

/** GTIN mod-10 (GTIN-8/12/13/14): weighted 3/1 from the right of the check digit. */
function gtinOk(digits: string): boolean {
	if (!/^\d+$/.test(digits) || ![8, 12, 13, 14].includes(digits.length)) return false;
	let sum = 0;
	// Rightmost digit is the check digit; weight alternates 3,1,3,1… over the body.
	for (let i = 0; i < digits.length - 1; i++) {
		const d = digits.charCodeAt(i) - 48;
		const fromRight = digits.length - 1 - i; // position of this digit counting the check digit as 0
		sum += d * (fromRight % 2 === 1 ? 3 : 1);
	}
	const check = (10 - (sum % 10)) % 10;
	return check === digits.charCodeAt(digits.length - 1) - 48;
}

function ipv4Ok(s: string): boolean {
	const p = s.split(".");
	return p.length === 4 && p.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255 && (o === "0" || !o.startsWith("0")));
}

function ipv6Ok(s: string): boolean {
	if (!/^[0-9A-Fa-f:]+$/.test(s) || (s.match(/::/g)?.length ?? 0) > 1) return false;
	const hasDouble = s.includes("::");
	const parts = s.split("::");
	const groups = (str: string) => (str ? str.split(":") : []);
	const head = groups(parts[0]);
	const tail = hasDouble ? groups(parts[1] ?? "") : [];
	const all = [...head, ...tail];
	if (all.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
	return hasDouble ? all.length <= 7 : all.length === 8;
}

const RE = {
	email: /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/,
	url: /^https?:\/\/[^\s/$.?#][^\s]*$/i,
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	iso_date: /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/,
};

function checkFormat(data: string, format: Format): string[] {
	const errors: string[] = [];
	switch (format) {
		case "email":
			if (!RE.email.test(data)) errors.push("not a valid email address");
			break;
		case "url":
			if (!RE.url.test(data)) errors.push("not a valid http(s) URL");
			break;
		case "uuid":
			if (!RE.uuid.test(data)) errors.push("not a valid UUID");
			break;
		case "ipv4":
			if (!ipv4Ok(data)) errors.push("not a valid IPv4 address");
			break;
		case "ipv6":
			if (!ipv6Ok(data)) errors.push("not a valid IPv6 address");
			break;
		case "json":
			try {
				JSON.parse(data);
			} catch (e) {
				errors.push(`not valid JSON: ${(e as Error).message}`);
			}
			break;
		case "credit_card":
			if (!luhnOk(data.replace(/[\s-]/g, ""))) errors.push("fails Luhn check / wrong length");
			break;
		case "gtin":
			if (!gtinOk(data.replace(/[\s-]/g, ""))) errors.push("fails GTIN mod-10 check / wrong length");
			break;
		case "iso_date":
			if (!RE.iso_date.test(data) || Number.isNaN(new Date(data).getTime())) errors.push("not a valid ISO 8601 date");
			break;
	}
	return errors;
}

type Schema = { type?: string; required?: string[]; properties?: Record<string, { type?: string }> };

function jsType(v: unknown): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

function checkSchema(data: string, schema: Schema): string[] {
	const errors: string[] = [];
	let value: unknown;
	try {
		value = JSON.parse(data);
	} catch (e) {
		return [`data is not valid JSON: ${(e as Error).message}`];
	}
	if (schema.type && jsType(value) !== schema.type) {
		errors.push(`expected type '${schema.type}' but got '${jsType(value)}'`);
		return errors; // further checks assume the container type
	}
	if (value && typeof value === "object" && !Array.isArray(value)) {
		const obj = value as Record<string, unknown>;
		for (const key of schema.required ?? []) {
			if (!(key in obj)) errors.push(`missing required property '${key}'`);
		}
		for (const [key, spec] of Object.entries(schema.properties ?? {})) {
			if (key in obj && spec?.type && jsType(obj[key]) !== spec.type) {
				errors.push(`property '${key}' expected type '${spec.type}' but got '${jsType(obj[key])}'`);
			}
		}
	}
	return errors;
}

export const validate: Fn = {
	name: "validate",
	description:
		"Validate a string value against a named format or a minimal JSON shape. Provide exactly one of `format` (email, url, uuid, ipv4, ipv6, json, credit_card, gtin, iso_date) or `schema` ({ type, required[], properties:{ name:{ type } } }, checked against parsed JSON in `data`). credit_card uses Luhn; gtin uses the GTIN mod-10 check. Returns JSON { valid, errors:[...] }.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "The value to validate (raw string; JSON text when using `format: json` or `schema`)." },
			format: { type: "string", enum: [...FORMATS], description: "Named format to check against." },
			schema: {
				type: "object",
				description: "Minimal shape: { type, required:[string], properties:{ key:{ type } } }.",
				properties: {
					type: { type: "string" },
					required: { type: "array", items: { type: "string" } },
					properties: { type: "object" },
				},
			},
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		if (typeof args?.data !== "string") return fail("`data` must be a string.");
		const hasFormat = args?.format !== undefined;
		const hasSchema = args?.schema !== undefined;
		if (hasFormat && hasSchema) return fail("Provide either `format` or `schema`, not both.");
		if (!hasFormat && !hasSchema) return fail("Provide a `format` or a `schema` to validate against.");

		let errors: string[];
		if (hasFormat) {
			if (!FORMATS.includes(args.format)) return fail(`Unknown format '${args.format}'. Allowed: ${FORMATS.join(", ")}.`);
			errors = checkFormat(args.data, args.format as Format);
		} else {
			if (typeof args.schema !== "object" || args.schema === null || Array.isArray(args.schema)) {
				return fail("`schema` must be an object.");
			}
			errors = checkSchema(args.data, args.schema as Schema);
		}

		return ok(JSON.stringify({ valid: errors.length === 0, errors }, null, 2));
	},
};
