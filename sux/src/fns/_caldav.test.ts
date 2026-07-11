import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVEvent, buildVTodo, caldavFetch, hasCalDav, icalStamp, listCalendars, parseICal, reportObjects } from "./_caldav";

const env = () => ({ FASTMAIL_CALDAV_USER: "me@fastmail.com", FASTMAIL_APP_PASSWORD: "app-pw" }) as any;

afterEach(() => vi.restoreAllMocks());

describe("_caldav iCal build/parse", () => {
	it("icalStamp: ISO date-time → UTC stamp; date-only → VALUE=DATE", () => {
		expect(icalStamp("2026-07-11T09:00:00Z")).toEqual({ value: "20260711T090000Z", dateOnly: false });
		expect(icalStamp("2026-07-11")).toEqual({ value: "20260711", dateOnly: true });
		expect(() => icalStamp("not-a-date")).toThrow(/invalid/);
	});

	it("buildVEvent emits a valid VCALENDAR/VEVENT with escaping", () => {
		const ical = buildVEvent({ uid: "u1", summary: "Lunch, w/ Ada; notes", start: "2026-07-11T12:00:00Z", end: "2026-07-11T13:00:00Z", location: "Cafe", dtstamp: "2026-07-10T00:00:00Z" });
		expect(ical).toContain("BEGIN:VEVENT");
		expect(ical).toContain("UID:u1");
		expect(ical).toContain("DTSTART:20260711T120000Z");
		expect(ical).toContain("DTEND:20260711T130000Z");
		expect(ical).toContain("SUMMARY:Lunch\\, w/ Ada\\; notes"); // TEXT escaping
		expect(ical).toContain("LOCATION:Cafe");
	});

	it("all-day event uses VALUE=DATE", () => {
		const ical = buildVEvent({ uid: "u2", summary: "Holiday", start: "2026-12-25", dtstamp: "2026-07-10T00:00:00Z" });
		expect(ical).toContain("DTSTART;VALUE=DATE:20261225");
	});

	it("buildVTodo emits a VTODO with STATUS", () => {
		const ical = buildVTodo({ uid: "t1", summary: "File taxes", due: "2026-04-15", dtstamp: "2026-07-10T00:00:00Z" });
		expect(ical).toContain("BEGIN:VTODO");
		expect(ical).toContain("DUE;VALUE=DATE:20260415");
		expect(ical).toContain("STATUS:NEEDS-ACTION");
	});

	it("parseICal round-trips a built event, unfolding + unescaping", () => {
		const long = "x".repeat(200);
		const ical = buildVEvent({ uid: "u3", summary: "A, B; C", start: "2026-07-11T09:00:00Z", description: long, dtstamp: "2026-07-10T00:00:00Z" });
		const [comp] = parseICal(ical);
		expect(comp.component).toBe("VEVENT");
		expect(comp.props.SUMMARY).toBe("A, B; C"); // unescaped
		expect(comp.props.DESCRIPTION).toBe(long); // folded then unfolded intact
		expect(comp.props.UID).toBe("u3");
	});
});

const MULTISTATUS_CALS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response><d:href>/dav/calendars/user/me@fastmail.com/</d:href>
    <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/calendars/user/me@fastmail.com/personal/</d:href>
    <d:propstat><d:prop><d:displayname>Personal</d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>
  <d:response><d:href>/dav/calendars/user/me@fastmail.com/tasks/</d:href>
    <d:propstat><d:prop><d:displayname>Tasks</d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>
</d:multistatus>`;

describe("_caldav discovery + report", () => {
	it("hasCalDav reflects both secrets", () => {
		expect(hasCalDav(env())).toBe(true);
		expect(hasCalDav({ FASTMAIL_CALDAV_USER: "x" } as any)).toBe(false);
	});

	it("listCalendars parses a multistatus, separating tasks from event calendars", async () => {
		global.fetch = vi.fn(async () => new Response(MULTISTATUS_CALS, { status: 207 })) as any;
		const cals = await listCalendars(env());
		expect(cals).toHaveLength(2); // the home collection (no calendar resourcetype) is skipped
		expect(cals.find((c) => c.name === "Personal")).toMatchObject({ isTasks: false });
		expect(cals.find((c) => c.name === "Tasks")).toMatchObject({ isTasks: true });
	});

	it("caldavFetch injects Basic auth + returns etag", async () => {
		const f = vi.fn(async () => new Response("ok", { status: 200, headers: { etag: '"abc"' } }));
		global.fetch = f as any;
		const r = await caldavFetch(env(), "GET", "/dav/calendars/user/me@fastmail.com/personal/x.ics");
		expect(r.etag).toBe('"abc"');
		expect(((f.mock.calls[0] as any[])[1] as any).headers.Authorization).toMatch(/^Basic /);
	});

	it("reportObjects pulls calendar-data blocks from a REPORT multistatus", async () => {
		const ical = buildVEvent({ uid: "e9", summary: "Standup", start: "2026-07-11T09:00:00Z", dtstamp: "2026-07-10T00:00:00Z" });
		const body = `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/calendars/user/me@fastmail.com/personal/e9.ics</d:href><d:propstat><d:prop><d:getetag>"e1"</d:getetag><c:calendar-data>${ical}</c:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`;
		global.fetch = vi.fn(async () => new Response(body, { status: 207 })) as any;
		const objs = await reportObjects(env(), "/dav/calendars/user/me@fastmail.com/personal/", "VEVENT");
		expect(objs).toHaveLength(1);
		expect(objs[0]).toMatchObject({ etag: '"e1"' });
		expect(parseICal(objs[0].ical)[0].props.SUMMARY).toBe("Standup");
	});
});
