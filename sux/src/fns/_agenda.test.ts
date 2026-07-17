import { describe, expect, it, vi } from "vitest";
import { composeDigest, type AgendaDeps, detectDrops, detectMonarchDrops, type EventRef, type MailRef, type MonarchAccountRef, type MonarchTxnRef, runAgenda } from "./_agenda";
import { listProposals } from "../proposals";

function kvStub() {
	const map = new Map<string, string>();
	return { map, get: vi.fn(async (k: string) => map.get(k) ?? null), put: vi.fn(async (k: string, v: string) => void map.set(k, v)), delete: vi.fn(async (k: string) => void map.delete(k)) };
}
const env = (extra: Record<string, unknown> = {}) => ({ AGENDA_ENABLED: "1", VAULT_TZ: "UTC", OAUTH_KV: kvStub(), ...extra }) as any;

const MAIL: MailRef[] = [
	{ id: "rx1", from: "pharmacy@uwmc.org", subject: "Your prescription is ready for pickup" },
	{ id: "pay1", from: "failed-payments@mail.anthropic.com", subject: "$14.77 payment to Anthropic was unsuccessful" },
	{ id: "med1", from: "no-reply@mychart.com", subject: "You have a new secure message" },
	{ id: "appt1", from: "scheduling@uw.edu", subject: "Your appointment has been rescheduled" },
	{ id: "bill1", from: "billing@chase.com", subject: "Your statement is ready" },
	{ id: "pers1", from: "jeanne@gmail.com", subject: "Hey!", preview: "can you call me sometime this week?" },
	{ id: "noise1", from: "newsletter@bloomberg.com", subject: "Can airports be zen?" },
];
const EVENTS: EventRef[] = [{ summary: "Intake appointment w/ Dr. Enoch", start: "2026-07-15T09:00:00" }];

const deps = (over: Partial<AgendaDeps> = {}): AgendaDeps => ({
	mailSearch: vi.fn(async () => MAIL),
	calEvents: vi.fn(async () => EVENTS),
	digestAppend: vi.fn(async () => {}),
	sendDigest: vi.fn(async () => {}),
	...over,
});

describe("agenda — detectors", () => {
	it("detects each drop kind from the mail+calendar stream, skips noise", () => {
		const drops = detectDrops(MAIL, EVENTS);
		const kinds = drops.map((d) => d.kind);
		expect(kinds).toContain("rx_ready");
		expect(kinds).toContain("payment_problem");
		expect(kinds).toContain("medical_message");
		expect(kinds).toContain("appointment");
		expect(kinds).toContain("bill_due");
		expect(kinds).toContain("unanswered"); // jeanne
		expect(kinds).toContain("appointment_cal"); // the calendar event
		expect(kinds).not.toContain("noise"); // the bloomberg newsletter raises nothing
		expect(drops).toHaveLength(7);
	});

	it("every drop's action is a reversible Todoist add (rung-0, no model)", () => {
		for (const d of detectDrops(MAIL, EVENTS)) {
			expect(d.action.fn).toBe("todoist");
			expect(d.action.args).toMatchObject({ action: "add" });
		}
	});

	it("ranks today-urgency (Rx, payment) ahead of soon/fyi", () => {
		const drops = detectDrops(MAIL, EVENTS);
		expect(drops[0].urgency).toBe("today");
		expect(drops[drops.length - 1].urgency).toBe("fyi"); // the unanswered personal note
	});
});

describe("agenda — Monarch detectors (W7)", () => {
	const ACCOUNTS: MonarchAccountRef[] = [
		{ id: "chk1", name: "Everyday Checking", balance: 42.13, type: "depository", subtype: "checking" },
		{ id: "sav1", name: "Emergency Savings", balance: 5000, type: "depository", subtype: "savings" },
		{ id: "cc1", name: "Rewards Card", balance: -300, type: "credit" },
	];
	const TXNS: MonarchTxnRef[] = [
		{ id: "t1", amount: -812.5, date: "2026-07-16", merchant: "Unknown Electronics Co" },
		{ id: "t2", amount: -45, date: "2026-07-16", pending: true, category: "Bills & Utilities", merchant: "City Power" },
		{ id: "t3", amount: -12.5, date: "2026-07-16", merchant: "Coffee Shop" },
	];

	it("flags a depository account below the low-balance threshold, ignores credit + healthy accounts", () => {
		const drops = detectMonarchDrops(ACCOUNTS, []);
		expect(drops).toHaveLength(1);
		expect(drops[0].kind).toBe("low_balance");
		expect(drops[0].dedupe).toBe("lowbal::chk1");
	});

	it("flags a single large charge as unusual, and a pending bill-shaped charge as bill_due", () => {
		const drops = detectMonarchDrops([], TXNS);
		const kinds = drops.map((d) => d.kind);
		expect(kinds).toContain("unusual_charge");
		expect(kinds).toContain("bill_due");
		expect(kinds).not.toContain("noise"); // the coffee charge raises nothing
		expect(drops).toHaveLength(2);
	});

	it("every Monarch drop's action is a reversible Todoist add", () => {
		for (const d of detectMonarchDrops(ACCOUNTS, TXNS)) {
			expect(d.action.fn).toBe("todoist");
			expect(d.action.args).toMatchObject({ action: "add" });
		}
	});
});

describe("agenda — digest", () => {
	it("empty → a calm 'nothing pressing' note", () => {
		const d = composeDigest("2026-07-13", []);
		expect(d.body).toMatch(/nothing's about to slip/i);
	});
	it("groups by urgency, shows short ids + the reply-syntax interface", () => {
		const d = composeDigest("2026-07-13", [{ proposalId: "abcdef1234", drop: detectDrops(MAIL, [])[0] }]);
		expect(d.subject).toMatch(/need/);
		expect(d.body).toContain("abcdef12"); // short id (first 8)
		expect(d.body).toMatch(/approve <id>/);
	});
});

describe("agenda — loop", () => {
	it("is dormant (no-op) unless AGENDA_ENABLED", async () => {
		const r = await runAgenda({ VAULT_TZ: "UTC", OAUTH_KV: kvStub() } as any, {}, deps());
		expect(r.dormant).toBe(true);
	});

	it("armed: detects, records a proposal per drop, appends the digest, does NOT email (AGENDA_EMAIL unset)", async () => {
		const e = env();
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.proposed).toBe(7);
		expect(r.digest_written).toBe(true);
		expect(r.emailed).toBe(false);
		expect(d.sendDigest).not.toHaveBeenCalled();
		expect(d.digestAppend).toHaveBeenCalledTimes(1);
		// the proposals are really recorded in the W1 queue
		expect((await listProposals(e)).length).toBe(7);
	});

	it("emails the digest to self only when AGENDA_EMAIL is armed", async () => {
		const e = env({ AGENDA_EMAIL: "1" });
		const d = deps();
		const r = await runAgenda(e, {}, d);
		expect(r.emailed).toBe(true);
		expect(d.sendDigest).toHaveBeenCalledTimes(1);
	});

	it("is idempotent — a second cycle re-proposes nothing (dedupe ledger)", async () => {
		const e = env();
		await runAgenda(e, {}, deps());
		const second = await runAgenda(e, {}, deps());
		expect(second.proposed).toBe(0);
		expect((await listProposals(e)).length).toBe(7); // unchanged
	});

	it("dry_run: detects + composes but records/sends nothing", async () => {
		const e = env({ AGENDA_EMAIL: "1" });
		const d = deps();
		const r = await runAgenda(e, { dry_run: true }, d);
		expect(r.drops_detected).toBe(7);
		expect(r.digest).toMatch(/about to slip/i);
		expect(d.digestAppend).not.toHaveBeenCalled();
		expect(d.sendDigest).not.toHaveBeenCalled();
		expect((await listProposals(e)).length).toBe(0); // nothing recorded
	});

	it("a source failure degrades independently, never fatal", async () => {
		const e = env();
		const r = await runAgenda(e, {}, deps({ calEvents: vi.fn(async () => { throw new Error("caldav down"); }) }));
		expect(r.sources.calendar).toMatch(/unavailable/);
		expect(r.proposed).toBeGreaterThan(0); // mail drops still recorded
	});

	it("merges Monarch drops in when monarchSignals is wired, and degrades independently on failure", async () => {
		const e = env();
		const r = await runAgenda(e, {}, deps({
			monarchSignals: vi.fn(async () => ({
				accounts: [{ id: "chk1", name: "Checking", balance: 10, type: "depository" }],
				transactions: [],
			})),
		}));
		expect(r.sources.monarch).toMatch(/1 account/);
		expect(r.proposed).toBe(8); // 7 mail/calendar drops + 1 low-balance drop

		const r2 = await runAgenda(env(), {}, deps({ monarchSignals: vi.fn(async () => { throw new Error("monarch down"); }) }));
		expect(r2.sources.monarch).toMatch(/unavailable/);
		expect(r2.proposed).toBeGreaterThan(0);
	});

	it("skips Monarch entirely when monarchSignals is not wired (no source entry, no throw)", async () => {
		const e = env();
		const r = await runAgenda(e, {}, deps());
		expect(r.sources.monarch).toBeUndefined();
	});
});
