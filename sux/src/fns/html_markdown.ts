import { type Fn, fail, ok } from "../registry";

// Decode the handful of named/numeric HTML entities that survive tag stripping.
function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, " ")
		.replace(/&#x27;/gi, "'")
		.replace(/&#39;/g, "'")
		.replace(/&apos;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

function encodeEntities(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Strip any leftover tags and collapse whitespace inside inline content.
function inlineText(s: string): string {
	return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

// Convert inline HTML (links, bold, em, code) to Markdown, then flatten the rest.
function inlineToMd(s: string): string {
	return decodeEntities(
		s
			.replace(/<a\b[^>]*\bhref=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${inlineText(txt)}](${href})`)
			.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `**${inlineText(txt)}**`)
			.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `*${inlineText(txt)}*`)
			.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, txt) => `\`${inlineText(txt)}\``)
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<[^>]+>/g, ""),
	)
		.replace(/[ \t]+/g, " ")
		.trim();
}

function listItems(html: string, ordered: boolean): string {
	const items: string[] = [];
	const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
	let m: RegExpExecArray | null;
	let n = 1;
	while ((m = re.exec(html))) items.push(`${ordered ? `${n++}.` : "-"} ${inlineToMd(m[1])}`);
	return items.join("\n");
}

function htmlToMd(html: string): string {
	let s = html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "");

	// Block elements -> Markdown, using \x00 as a paragraph-separator sentinel.
	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lvl, txt) => `\x00${"#".repeat(Number(lvl))} ${inlineToMd(txt)}\x00`);
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, txt) => {
		const inner = inlineText(txt.replace(/<code\b[^>]*>|<\/code>/gi, ""));
		return `\x00\`\`\`\n${inner}\n\`\`\`\x00`;
	});
	s = s.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, txt) =>
		`\x00${inlineToMd(txt).split("\n").map((l: string) => `> ${l}`.trimEnd()).join("\n")}\x00`,
	);
	s = s.replace(/<ul\b[^>]*>([\s\S]*?)<\/ul>/gi, (_m, txt) => `\x00${listItems(txt, false)}\x00`);
	s = s.replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, txt) => `\x00${listItems(txt, true)}\x00`);
	s = s.replace(/<p\b[^>]*>([\s\S]*?)<\/p>/gi, (_m, txt) => `\x00${inlineToMd(txt)}\x00`);

	// Whatever remains at top level becomes paragraph text.
	s = inlineToMd(s.replace(/\x00/g, "\n\n"));

	return s
		.split(/\n{2,}/)
		.map((b) => b.trim())
		.filter(Boolean)
		.join("\n\n");
}

// --- Markdown -> HTML (same subset) ---

function inlineMdToHtml(s: string): string {
	return encodeEntities(s)
		.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
		.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_m, txt, href) => `<a href="${href}">${txt}</a>`)
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/__([^_]+)__/g, "<strong>$1</strong>")
		.replace(/\*([^*]+)\*/g, "<em>$1</em>")
		.replace(/_([^_]+)_/g, "<em>$1</em>");
}

function mdToHtml(md: string): string {
	const lines = md.replace(/\r\n?/g, "\n").split("\n");
	const out: string[] = [];
	let i = 0;

	const flushList = (items: string[], ordered: boolean) => {
		if (!items.length) return;
		const tag = ordered ? "ol" : "ul";
		out.push(`<${tag}>${items.map((t) => `<li>${inlineMdToHtml(t)}</li>`).join("")}</${tag}>`);
	};

	while (i < lines.length) {
		const line = lines[i];

		if (/^\s*$/.test(line)) {
			i++;
			continue;
		}

		// Fenced code block.
		if (/^```/.test(line)) {
			const body: string[] = [];
			i++;
			while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
			i++; // skip closing fence
			out.push(`<pre><code>${encodeEntities(body.join("\n"))}</code></pre>`);
			continue;
		}

		// Heading.
		const h = line.match(/^(#{1,6})\s+(.*)$/);
		if (h) {
			out.push(`<h${h[1].length}>${inlineMdToHtml(h[2].trim())}</h${h[1].length}>`);
			i++;
			continue;
		}

		// Blockquote.
		if (/^\s*>/.test(line)) {
			const body: string[] = [];
			while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
			out.push(`<blockquote>${inlineMdToHtml(body.join(" ").trim())}</blockquote>`);
			continue;
		}

		// Unordered list.
		if (/^\s*[-*+]\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ""));
			flushList(items, false);
			continue;
		}

		// Ordered list.
		if (/^\s*\d+\.\s+/.test(line)) {
			const items: string[] = [];
			while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+\.\s+/, ""));
			flushList(items, true);
			continue;
		}

		// Paragraph: consume until a blank line or block starter.
		const para: string[] = [];
		while (
			i < lines.length &&
			!/^\s*$/.test(lines[i]) &&
			!/^(#{1,6}\s|```|\s*>|\s*[-*+]\s|\s*\d+\.\s)/.test(lines[i])
		) {
			para.push(lines[i++]);
		}
		out.push(`<p>${inlineMdToHtml(para.join(" ").trim())}</p>`);
	}

	return out.join("\n");
}

export const htmlMarkdown: Fn = {
	name: "html_markdown",
	description:
		"Convert between HTML and Markdown for a common subset: headings (h1-h6), links, bold/strong, italic/em, unordered/ordered lists, inline code, code blocks (pre/```), blockquotes, and paragraphs. direction: html_to_md (default) | md_to_html. Other tags/attributes are stripped (html_to_md) or passed through as text; tables, images, and nested lists are not handled. Returns the converted string.",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		required: ["data"],
		properties: {
			data: { type: "string", description: "HTML (html_to_md) or Markdown (md_to_html) source." },
			direction: { type: "string", enum: ["html_to_md", "md_to_html"], default: "html_to_md" },
		},
	},
	cacheable: true,
	run: async (_env, args) => {
		const data = String(args?.data ?? "");
		if (!data.trim()) return fail("data is required.");
		const direction = args?.direction === "md_to_html" ? "md_to_html" : "html_to_md";
		try {
			return ok(direction === "md_to_html" ? mdToHtml(data) : htmlToMd(data));
		} catch (e) {
			return fail(`${direction} failed: ${String((e as Error).message ?? e)}`);
		}
	},
};
