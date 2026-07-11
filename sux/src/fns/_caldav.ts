import { type RtEnv } from "../registry";

// CalDAV engine — Fastmail's calendar + tasks (RFC 4791/5545) over an app-specific password.
// JMAP has no jmap:calendars capability on Fastmail, so calendars ride CalDAV instead: Basic
// auth (FASTMAIL_CALDAV_USER : FASTMAIL_APP_PASSWORD), PROPFIND/REPORT to discover + read,
// PUT/DELETE with ETag preconditions to mutate. iCal is built + parsed here so the ergonomic
// cal_*/task_* verbs never hand-roll RFC 5545. Design: docs/design/sux-integration-ultracode-workflow.md §3.
//
// Everything is inert until both secrets are set — hasCalDav(env) gates every verb with a clear
// not_configured message. XML/iCal parsing is regex-based against Fastmail's known response
// shape (Workers have no DOMParser); it curates the common properties, not the whole spec.

const CALDAV_HOST = "https://caldav.fastmail.com";

export function hasCalDav(env: RtEnv): boolean {
	return !!(env as any).FASTMAIL_CALDAV_USER && !!(env as any).FASTMAIL_APP_PASSWORD;
}

export const CALDAV_NOT_CONFIGURED =
	"Fastmail calendar/tasks need CalDAV credentials. Set FASTMAIL_CALDAV_USER (your Fastmail login/email) and FASTMAIL_APP_PASSWORD (Settings → Privacy & Security → App passwords → new, with Calendars/CalDAV access). JMAP has no calendars capability on Fastmail, so this is a separate credential — the verbs are otherwise ready.";

function authHeader(env: RtEnv): string {
	const user = String((env as any).FASTMAIL_CALDAV_USER);
	const pass = String((env as any).FASTMAIL_APP_PASSWORD);
	return `Basic ${btoa(`${user}:${pass}`)}`;
}

const POST_TIMEOUT_MS = 30_000;

export type CalDavResponse = { status: number; ok: boolean; text: string; etag: string | null };

/** One authenticated CalDAV request. `path` is absolute-from-host or a full URL. */
export async function caldavFetch(
	env: RtEnv,
	method: string,
	path: string,
	opts: { body?: string; contentType?: string; depth?: string; ifMatch?: string; ifNoneMatch?: string } = {},
): Promise<CalDavResponse> {
	const url = path.startsWith("http") ? path : `${CALDAV_HOST}${path}`;
	const headers: Record<string, string> = { Authorization: authHeader(env) };
	if (opts.contentType) headers["Content-Type"] = opts.contentType;
	if (opts.depth) headers.Depth = opts.depth;
	if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;
	if (opts.ifNoneMatch) headers["If-None-Match"] = opts.ifNoneMatch;
	const resp = await fetch(url, { method, headers, body: opts.body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
	const text = await resp.text();
	return { status: resp.status, ok: resp.ok, text, etag: resp.headers.get("etag") };
}

/** The user's calendar-home collection path (where calendars live). */
export function calendarHome(env: RtEnv): string {
	return `/dav/calendars/user/${encodeURIComponent(String((env as any).FASTMAIL_CALDAV_USER))}/`;
}

// ---- XML (WebDAV multistatus) — regex extraction against Fastmail's response shape ----

const tag = (name: string) => new RegExp(`<(?:[a-zA-Z]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z]+:)?${name}>`, "i");
const tagAll = (name: string) => new RegExp(`<(?:[a-zA-Z]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-zA-Z]+:)?${name}>`, "gi");

/** Split a multistatus body into <response> blocks. */
export function multistatusResponses(xml: string): string[] {
	return [...xml.matchAll(tagAll("response"))].map((m) => m[1]);
}

function firstTag(block: string, name: string): string | null {
	const m = block.match(tag(name));
	return m ? m[1].trim() : null;
}

export type CalendarRef = { href: string; name: string; description?: string; isTasks: boolean };

/** PROPFIND the calendar-home (Depth 1) → the list of calendar collections. */
export async function listCalendars(env: RtEnv): Promise<CalendarRef[]> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
  <d:prop><d:displayname/><d:resourcetype/><c:supported-calendar-component-set/><c:calendar-description/></d:prop>
</d:propfind>`;
	const r = await caldavFetch(env, "PROPFIND", calendarHome(env), { body, contentType: "application/xml; charset=utf-8", depth: "1" });
	if (!r.ok && r.status !== 207) throw new Error(`CalDAV PROPFIND failed: HTTP ${r.status}`);
	const out: CalendarRef[] = [];
	for (const block of multistatusResponses(r.text)) {
		const href = firstTag(block, "href");
		if (!href) continue;
		const rtype = firstTag(block, "resourcetype") ?? "";
		if (!/calendar/i.test(rtype)) continue; // skip the home collection + non-calendar resources
		const comps = block.match(/supported-calendar-component-set([\s\S]*?)supported-calendar-component-set/i)?.[1] ?? "";
		const isTasks = /VTODO/i.test(comps) && !/VEVENT/i.test(comps);
		out.push({ href: href.trim(), name: firstTag(block, "displayname") ?? href.trim(), description: firstTag(block, "calendar-description") ?? undefined, isTasks });
	}
	return out;
}

// ---- iCalendar (RFC 5545) build + parse ----

/** Fold + escape one property line (RFC 5545 §3.1 line folding, §3.3.11 TEXT escaping). */
function icalLine(name: string, value: string): string {
	const escaped = String(value).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
	const line = `${name}:${escaped}`;
	if (line.length <= 73) return line;
	const chunks: string[] = [line.slice(0, 73)];
	let rest = line.slice(73);
	while (rest.length) {
		chunks.push(` ${rest.slice(0, 72)}`);
		rest = rest.slice(72);
	}
	return chunks.join("\r\n");
}

/** ISO-8601 → iCal UTC stamp (20260711T090000Z). A date-only value stays a VALUE=DATE. */
export function icalStamp(iso: string): { value: string; dateOnly: boolean } {
	if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { value: iso.replace(/-/g, ""), dateOnly: true };
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) throw new Error(`invalid date-time '${iso}' (want ISO-8601).`);
	const p = (n: number, w = 2) => String(n).padStart(w, "0");
	return { value: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`, dateOnly: false };
}

export type EventInput = { uid: string; summary: string; start: string; end?: string; description?: string; location?: string; dtstamp: string };

function dtProp(name: string, iso: string): string {
	const { value, dateOnly } = icalStamp(iso);
	return dateOnly ? `${name};VALUE=DATE:${value}` : icalLine(name, value);
}

/** Build a VCALENDAR wrapping one VEVENT. `dtstamp` is passed in (Workers forbid Date.now() ambient use elsewhere, but a real send needs a stamp). */
export function buildVEvent(e: EventInput): string {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//sux//caldav//EN",
		"BEGIN:VEVENT",
		icalLine("UID", e.uid),
		dtProp("DTSTAMP", e.dtstamp),
		dtProp("DTSTART", e.start),
		...(e.end ? [dtProp("DTEND", e.end)] : []),
		icalLine("SUMMARY", e.summary),
		...(e.description ? [icalLine("DESCRIPTION", e.description)] : []),
		...(e.location ? [icalLine("LOCATION", e.location)] : []),
		"END:VEVENT",
		"END:VCALENDAR",
	];
	return lines.join("\r\n");
}

export type TaskInput = { uid: string; summary: string; due?: string; description?: string; status?: string; dtstamp: string };

/** Build a VCALENDAR wrapping one VTODO. */
export function buildVTodo(t: TaskInput): string {
	const lines = [
		"BEGIN:VCALENDAR",
		"VERSION:2.0",
		"PRODID:-//sux//caldav//EN",
		"BEGIN:VTODO",
		icalLine("UID", t.uid),
		dtProp("DTSTAMP", t.dtstamp),
		...(t.due ? [dtProp("DUE", t.due)] : []),
		icalLine("SUMMARY", t.summary),
		...(t.description ? [icalLine("DESCRIPTION", t.description)] : []),
		icalLine("STATUS", t.status ?? "NEEDS-ACTION"),
		"END:VTODO",
		"END:VCALENDAR",
	];
	return lines.join("\r\n");
}

/** Unfold (RFC 5545 §3.1) + parse an iCal blob into flat property maps per component. */
export function parseICal(text: string): Array<{ component: string; props: Record<string, string> }> {
	const unfolded = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "");
	const lines = unfolded.split(/\r\n|\n/);
	const out: Array<{ component: string; props: Record<string, string> }> = [];
	let cur: { component: string; props: Record<string, string> } | null = null;
	for (const line of lines) {
		if (/^BEGIN:(VEVENT|VTODO)/i.test(line)) cur = { component: line.split(":")[1].toUpperCase(), props: {} };
		else if (/^END:(VEVENT|VTODO)/i.test(line)) {
			if (cur) out.push(cur);
			cur = null;
		} else if (cur) {
			const idx = line.indexOf(":");
			if (idx < 0) continue;
			const rawName = line.slice(0, idx).split(";")[0].toUpperCase();
			const value = line.slice(idx + 1).replace(/\\n/g, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
			if (rawName) cur.props[rawName] = value;
		}
	}
	return out;
}

/** REPORT a calendar collection for its VEVENT/VTODO objects in a time-agnostic query. */
export async function reportObjects(env: RtEnv, calendarHref: string, comp: "VEVENT" | "VTODO"): Promise<Array<{ href: string; etag: string | null; ical: string }>> {
	const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="${comp}"/></c:comp-filter></c:filter>
</c:calendar-query>`;
	const r = await caldavFetch(env, "REPORT", calendarHref, { body, contentType: "application/xml; charset=utf-8", depth: "1" });
	if (!r.ok && r.status !== 207) throw new Error(`CalDAV REPORT failed: HTTP ${r.status}`);
	const out: Array<{ href: string; etag: string | null; ical: string }> = [];
	for (const block of multistatusResponses(r.text)) {
		const href = firstTag(block, "href");
		const ical = firstTag(block, "calendar-data");
		if (href && ical) out.push({ href: href.trim(), etag: firstTag(block, "getetag"), ical: ical.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&") });
	}
	return out;
}
