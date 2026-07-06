import { type Fn, fail, ok } from "../registry";

function decodeEntities(s: string): string {
	return s
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(parseInt(d, 10)))
		.replace(/&amp;/g, "&");
}

function encodeEntities(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Attach a child under `name`, promoting to an array when the tag repeats.
function attach(node: Record<string, unknown>, name: string, child: unknown) {
	if (name in node) {
		const cur = node[name];
		if (Array.isArray(cur)) cur.push(child);
		else node[name] = [cur, child];
	} else node[name] = child;
}

// Collapse a node that carries only text into a bare string.
function collapse(node: Record<string, unknown>): unknown {
	const keys = Object.keys(node);
	if (keys.length === 1 && keys[0] === "#text") return node["#text"];
	return node;
}

// Hand-rolled stack parser. Comments, prolog, and doctype are stripped;
// CDATA is unwrapped to raw text. `nodes`/`names` are parallel stacks so the
// emitted objects never carry parser bookkeeping keys.
function parseXml(xml: string): unknown {
	const src = xml
		.replace(/<\?[\s\S]*?\?>/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<!DOCTYPE[^>]*>/gi, "")
		.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_m, c) => encodeEntities(c));

	const root: Record<string, unknown> = {};
	const nodes: Record<string, unknown>[] = [root];
	const names: string[] = [""];
	let pos = 0;

	while (pos < src.length) {
		const lt = src.indexOf("<", pos);
		if (lt === -1) break;

		const text = src.slice(pos, lt);
		if (text.trim()) {
			const top = nodes[nodes.length - 1];
			top["#text"] = ((top["#text"] as string) ?? "") + decodeEntities(text).trim();
		}

		const gt = src.indexOf(">", lt);
		if (gt === -1) throw new Error("unterminated tag");
		let tag = src.slice(lt + 1, gt).trim();

		if (tag.startsWith("/")) {
			// Closing tag: it must match the node on top of the stack.
			const closing = tag.slice(1).trim();
			if (nodes.length < 2) throw new Error(`unexpected closing tag </${closing}>`);
			const expected = names[names.length - 1];
			if (closing !== expected) throw new Error(`mismatched tag: expected </${expected}>, got </${closing}>`);
			const finished = nodes.pop()!;
			names.pop();
			attach(nodes[nodes.length - 1], expected, collapse(finished));
			pos = gt + 1;
			continue;
		}

		const selfClose = tag.endsWith("/");
		if (selfClose) tag = tag.slice(0, -1).trim();
		const name = tag.match(/^([\w:.-]+)/)?.[1];
		if (!name) throw new Error("malformed tag");

		const node: Record<string, unknown> = {};
		for (const a of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"|([\w:.-]+)\s*=\s*'([^']*)'/g)) {
			const key = a[1] ?? a[3];
			const val = a[2] ?? a[4] ?? "";
			node["@" + key] = decodeEntities(val);
		}

		if (selfClose) {
			attach(nodes[nodes.length - 1], name, Object.keys(node).length ? node : "");
		} else {
			nodes.push(node);
			names.push(name);
		}
		pos = gt + 1;
	}

	if (nodes.length !== 1) throw new Error("unclosed tag(s)");
	return collapse(root);
}

function toXml(obj: unknown, name?: string): string {
	if (obj === null || obj === undefined) return name ? `<${name}/>` : "";
	if (Array.isArray(obj)) return obj.map((v) => toXml(v, name)).join("");
	if (typeof obj === "object") {
		const entries = Object.entries(obj as Record<string, unknown>);
		const attrs = entries
			.filter(([k]) => k.startsWith("@"))
			.map(([k, v]) => ` ${k.slice(1)}="${encodeEntities(String(v))}"`)
			.join("");
		const inner = entries
			.filter(([k]) => !k.startsWith("@"))
			.map(([k, v]) => (k === "#text" ? encodeEntities(String(v)) : toXml(v, k)))
			.join("");
		if (!name) return inner;
		return inner === "" && attrs !== "" ? `<${name}${attrs}/>` : `<${name}${attrs}>${inner}</${name}>`;
	}
	const esc = encodeEntities(String(obj));
	return name ? `<${name}>${esc}</${name}>` : esc;
}

export const xmlJson: Fn = {
	name: "xml_json",
	description:
		"Convert between XML and JSON. direction: xml_to_json (default) | json_to_xml. xml_to_json: a stack parser -> nested objects with attributes under '@attr', text under '#text'; repeated child tags become arrays; self-closing tags and CDATA are handled; basic entities are decoded. json_to_xml: the inverse. Limitations: XML namespaces are kept verbatim (not resolved), comments/prolog/doctype are dropped, and mixed text+element ordering is not preserved. Returns pretty JSON (xml_to_json) or XML text (json_to_xml).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "XML text (xml_to_json) or JSON (json_to_xml)." },
			direction: { type: "string", enum: ["xml_to_json", "json_to_xml"], default: "xml_to_json" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("data is required.");
		const direction = args?.direction === "json_to_xml" ? "json_to_xml" : "xml_to_json";
		try {
			if (direction === "json_to_xml") return ok(toXml(JSON.parse(data)));
			return ok(JSON.stringify(parseXml(data), null, 2));
		} catch (e) {
			return fail(`${direction} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
