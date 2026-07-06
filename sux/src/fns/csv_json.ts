import { type Fn, fail, ok } from "../registry";

// RFC4180-ish CSV parser: handles quoted fields with embedded delimiters,
// escaped quotes ("") and newlines inside quotes. `\r\n` and `\r` normalize to a row break.
function parseCsv(text: string, delim: string): string[][] {
	const rows: string[][] = [];
	let row: string[] = [];
	let field = "";
	let inQ = false;
	let started = false; // did the current field/row have any content or a delimiter?

	const pushField = () => {
		row.push(field);
		field = "";
	};
	const pushRow = () => {
		pushField();
		rows.push(row);
		row = [];
		started = false;
	};

	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inQ) {
			if (c === '"') {
				if (text[i + 1] === '"') {
					field += '"';
					i++;
				} else inQ = false;
			} else field += c;
			continue;
		}
		if (c === '"') {
			inQ = true;
			started = true;
		} else if (c === delim) {
			pushField();
			started = true;
		} else if (c === "\n") {
			pushRow();
		} else if (c === "\r") {
			// swallow; a following \n also triggers pushRow, so only break here if lone \r
			if (text[i + 1] !== "\n") pushRow();
		} else {
			field += c;
			started = true;
		}
	}
	if (started || field.length || row.length) pushRow();
	// Drop a trailing empty row produced by a final newline.
	return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

function toCsv(arr: unknown[], delim: string): string {
	if (!arr.length) return "";
	const headers = [...new Set(arr.flatMap((o) => (o && typeof o === "object" ? Object.keys(o as object) : [])))];
	const esc = (v: unknown): string => {
		const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
		return new RegExp(`["${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\r\\n]`).test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const lines = [headers.join(delim)];
	for (const o of arr) lines.push(headers.map((h) => esc((o as Record<string, unknown>)?.[h])).join(delim));
	return lines.join("\n");
}

export const csvJson: Fn = {
	name: "csv_json",
	description:
		"Convert between CSV and JSON. direction: csv_to_json (default) | json_to_csv. delimiter defaults to ','. csv_to_json: first row = headers, following rows -> array of objects (RFC4180 quoting: embedded commas/quotes/newlines inside \"...\" fields are handled). json_to_csv: a JSON array of objects -> CSV with a header row (union of keys; object/array values are JSON-stringified). Returns the converted string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "CSV text (csv_to_json) or a JSON array of objects (json_to_csv)." },
			direction: { type: "string", enum: ["csv_to_json", "json_to_csv"], default: "csv_to_json" },
			delimiter: { type: "string", description: "Single-character field delimiter.", default: "," },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("data is required.");
		const delim = (String(args?.delimiter ?? ",").slice(0, 1) || ",");
		const direction = args?.direction === "json_to_csv" ? "json_to_csv" : "csv_to_json";
		try {
			if (direction === "json_to_csv") {
				const arr = JSON.parse(data);
				if (!Array.isArray(arr)) return fail("json_to_csv expects a JSON array of objects.");
				return ok(toCsv(arr, delim));
			}
			const rows = parseCsv(data, delim);
			if (!rows.length) return ok("[]");
			const headers = rows[0];
			const objs = rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""])));
			return ok(JSON.stringify(objs, null, 2));
		} catch (e) {
			return fail(`${direction} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
