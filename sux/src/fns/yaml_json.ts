import { type Fn, fail, ok } from "../registry";

// --- JSON -> YAML ---

function needsQuote(s: string): boolean {
	if (s === "") return true;
	// Quote when the value would otherwise be parsed as a non-string scalar,
	// or contains YAML-significant leading/trailing/structural characters.
	if (/^(true|false|null|~)$/i.test(s)) return true;
	if (/^-?\d+(\.\d+)?$/.test(s)) return true;
	return /[:#\[\]{}&*!|>'"%@`,]|^[\s?-]|\s$/.test(s);
}

function yamlScalar(v: unknown): string {
	if (v === null || v === undefined) return "null";
	if (typeof v === "boolean" || typeof v === "number") return String(v);
	if (Array.isArray(v)) return "[]"; // only reached for the empty case
	if (typeof v === "object") return "{}"; // only reached for the empty case
	const s = String(v);
	return needsQuote(s) ? JSON.stringify(s) : s;
}

function jsonToYaml(v: unknown, indent = 0): string {
	const pad = "  ".repeat(indent);
	if (Array.isArray(v)) {
		if (!v.length) return `${pad}[]`;
		return v
			.map((item) => {
				if (item !== null && typeof item === "object" && Object.keys(item as object).length) {
					// Render the child, then splice the dash in front of its first line.
					const block = jsonToYaml(item, indent + 1);
					return `${pad}-${block.slice(pad.length + 1)}`;
				}
				return `${pad}- ${yamlScalar(item)}`;
			})
			.join("\n");
	}
	if (v !== null && typeof v === "object") {
		const keys = Object.keys(v as object);
		if (!keys.length) return `${pad}{}`;
		return keys
			.map((k) => {
				const val = (v as Record<string, unknown>)[k];
				if (val !== null && typeof val === "object" && Object.keys(val as object).length) {
					return `${pad}${k}:\n${jsonToYaml(val, indent + 1)}`;
				}
				return `${pad}${k}: ${yamlScalar(val)}`;
			})
			.join("\n");
	}
	return `${pad}${yamlScalar(v)}`;
}

// --- YAML (common subset) -> JSON ---

function parseScalar(raw: string): unknown {
	const s = raw.trim();
	if (s === "" || s === "~" || s === "null") return null;
	if (s === "true") return true;
	if (s === "false") return false;
	if (/^-?\d+$/.test(s)) return parseInt(s, 10);
	if (/^-?\d*\.\d+$/.test(s)) return parseFloat(s);
	if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
		if (s[0] === '"') {
			try {
				return JSON.parse(s);
			} catch {
				return s.slice(1, -1);
			}
		}
		return s.slice(1, -1).replace(/''/g, "'");
	}
	if (s.startsWith("[") || s.startsWith("{")) {
		try {
			return JSON.parse(s);
		} catch {
			/* fall through to plain string */
		}
	}
	return s;
}

function yamlToJson(text: string): unknown {
	// Drop blank lines and full-line comments; strip trailing inline comments on unquoted content.
	const lines = text
		.split(/\r?\n/)
		.filter((l) => l.trim() !== "" && !/^\s*#/.test(l))
		.map((l) => (/["']/.test(l) ? l : l.replace(/\s+#.*$/, "")))
		.map((l) => l.replace(/\s+$/, ""));

	let i = 0;
	const indentOf = (l: string) => l.match(/^\s*/)![0].length;

	function parseBlock(minIndent: number): unknown {
		const first = lines[i];
		if (first === undefined) return null;
		if (/^\s*-(\s|$)/.test(first)) return parseSeq(minIndent);
		return parseMap(minIndent);
	}

	function parseSeq(minIndent: number): unknown[] {
		const arr: unknown[] = [];
		while (i < lines.length) {
			const line = lines[i];
			const ind = indentOf(line);
			if (ind < minIndent || !/^\s*-(\s|$)/.test(line)) break;
			const rest = line.slice(ind + 1).replace(/^\s*/, "");
			i++;
			if (rest === "") {
				arr.push(parseBlock(ind + 1));
			} else if (/^[^"'\[{][^:]*:(\s|$)/.test(rest)) {
				// "- key: value" — a map whose first key sits on the dash line.
				const m = rest.match(/^([^:]+):\s*(.*)$/)!;
				const obj: Record<string, unknown> = {};
				const childIndent = ind + 2;
				if (m[2].trim() === "") obj[m[1].trim()] = parseBlock(childIndent);
				else obj[m[1].trim()] = parseScalar(m[2]);
				mergeMap(obj, childIndent);
				arr.push(obj);
			} else {
				arr.push(parseScalar(rest));
			}
		}
		return arr;
	}

	function parseMap(minIndent: number): Record<string, unknown> {
		const obj: Record<string, unknown> = {};
		mergeMap(obj, minIndent);
		return obj;
	}

	function mergeMap(obj: Record<string, unknown>, minIndent: number) {
		while (i < lines.length) {
			const line = lines[i];
			const ind = indentOf(line);
			if (ind < minIndent || /^\s*-(\s|$)/.test(line.slice(ind))) break;
			const m = line.match(/^\s*([^:]+?):\s*(.*)$/);
			if (!m) break;
			i++;
			const key = m[1].trim();
			if (m[2].trim() === "") obj[key] = parseBlock(ind + 1);
			else obj[key] = parseScalar(m[2]);
		}
	}

	return parseBlock(0);
}

export const yamlJson: Fn = {
	name: "yaml_json",
	description:
		"Convert between a practical YAML subset and JSON. direction: yaml_to_json (default) | json_to_yaml. Supported subset: scalars (string/number/bool/null), nested maps by indentation, block sequences (- item), single/double-quoted strings, and # comments. NOT supported: anchors/aliases, block/multiline scalars (| >), complex flow collections, or multi-document streams — provide those forms differently. Returns pretty JSON (yaml_to_json) or YAML text (json_to_yaml).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "YAML text (yaml_to_json) or JSON (json_to_yaml)." },
			direction: { type: "string", enum: ["yaml_to_json", "json_to_yaml"], default: "yaml_to_json" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("data is required.");
		const direction = args?.direction === "json_to_yaml" ? "json_to_yaml" : "yaml_to_json";
		try {
			if (direction === "json_to_yaml") {
				const obj = JSON.parse(data);
				return ok(jsonToYaml(obj));
			}
			return ok(JSON.stringify(yamlToJson(data), null, 2));
		} catch (e) {
			return fail(`${direction} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
