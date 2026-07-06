import { type Fn, fail, ok } from "../registry";
import { isHttpUrl, fetchText, stripHtml } from "./_util";

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
// US-style (with optional country code) OR an E.164-ish international run.
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b|\+\d{7,15}\b/g;

export const contacts: Fn = {
	name: "contacts",
	description:
		"Extract contact info — email addresses and phone numbers (US and E.164-style international) — from a page or text. Pass `url`, `html`, or plain `text`. HTML/urls are stripped to text first. Returns JSON { emails, phones } (deduped).",
	inputSchema: {
		type: "object",
		additionalProperties: false,
		properties: {
			url: { type: "string", description: "URL to fetch (via proxy) and scan." },
			html: { type: "string", description: "Raw HTML to scan (stripped to text first)." },
			text: { type: "string", description: "Plain text to scan directly." },
		},
	},
	cacheable: true,
	run: async (env, args) => {
		let text = "";
		if (typeof args?.text === "string" && args.text) {
			text = args.text;
		} else if (typeof args?.html === "string" && args.html) {
			text = stripHtml(args.html);
		} else if (args?.url) {
			if (!isHttpUrl(args.url)) return fail("url must be an absolute http(s) URL.");
			text = stripHtml((await fetchText(env, String(args.url))).text);
		} else {
			return fail("Provide `url`, `html`, or `text`.");
		}

		const emails = new Set<string>();
		for (const m of text.matchAll(EMAIL)) emails.add(m[0].toLowerCase());

		const phones = new Set<string>();
		for (const m of text.matchAll(PHONE)) {
			const raw = m[0].trim();
			const digits = raw.replace(/\D/g, "");
			// Filter out obvious non-phones (too short, or a long unpunctuated ID run).
			if (digits.length >= 7 && digits.length <= 15) phones.add(raw);
		}

		return ok(
			JSON.stringify(
				{ emails: [...emails].slice(0, 200), phones: [...phones].slice(0, 200) },
				null,
				2,
			),
		);
	},
};
