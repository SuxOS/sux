import { afterEach, describe, expect, it, vi } from "vitest";
import type { CfSessionResult, CfSessionSpec } from "../cf-render";
import { CREDIT_KARMA, PORTAL_SOURCES, isExcludedPortalHost, runPortalScrape, solveViaCapSolver } from "./_portal_scrape";

// A fake fetch that answers CapSolver's createTask then getTaskResult (a queue of
// poll responses). Records every call so the request bodies can be asserted.
function capSolverFetch(create: any, results: any[]): typeof fetch {
	let idx = 0;
	return vi.fn(async (url: any, init: any) => {
		const u = String(url);
		if (u.includes("createTask")) return { json: async () => create } as any;
		const r = results[Math.min(idx, results.length - 1)];
		idx++;
		return { json: async () => r } as any;
	}) as unknown as typeof fetch;
}

const FAST = { pollIntervalMs: 1, timeoutMs: 1000, sleep: async () => {} };

const CHALLENGE = { provider: "recaptcha_v2" as const, siteKey: "SITEKEY", websiteUrl: "https://portal.example.com/login" };

describe("solveViaCapSolver", () => {
	it("returns null (no request) when CAPSOLVER_API_KEY is unset", async () => {
		const fetchImpl = capSolverFetch({ errorId: 0, taskId: "t1" }, [{ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "X" } }]);
		const token = await solveViaCapSolver({} as any, "recaptcha_v2", CHALLENGE, { ...FAST, fetchImpl });
		expect(token).toBeNull();
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("creates a reCAPTCHA v2 task and returns the solved gRecaptchaResponse", async () => {
		const fetchImpl = capSolverFetch({ errorId: 0, taskId: "t1" }, [{ errorId: 0, status: "ready", solution: { gRecaptchaResponse: "SOLVED_TOKEN" } }]);
		const token = await solveViaCapSolver({ CAPSOLVER_API_KEY: "cap" } as any, "recaptcha_v2", CHALLENGE, { ...FAST, fetchImpl });
		expect(token).toBe("SOLVED_TOKEN");
		const createBody = JSON.parse((fetchImpl as any).mock.calls[0][1].body);
		expect(createBody.clientKey).toBe("cap");
		expect(createBody.task.type).toBe("ReCaptchaV2TaskProxyLess");
		expect(createBody.task.websiteURL).toBe("https://portal.example.com/login");
		expect(createBody.task.websiteKey).toBe("SITEKEY");
	});

	it("maps Turnstile to AntiTurnstileTaskProxyLess and reads solution.token", async () => {
		const fetchImpl = capSolverFetch({ errorId: 0, taskId: "t2" }, [{ errorId: 0, status: "ready", solution: { token: "TS_TOKEN" } }]);
		const token = await solveViaCapSolver({ CAPSOLVER_API_KEY: "cap" } as any, "turnstile", { ...CHALLENGE, provider: "turnstile" as any }, { ...FAST, fetchImpl });
		expect(token).toBe("TS_TOKEN");
		expect(JSON.parse((fetchImpl as any).mock.calls[0][1].body).task.type).toBe("AntiTurnstileTaskProxyLess");
	});

	it("polls through a processing state before ready", async () => {
		const fetchImpl = capSolverFetch({ errorId: 0, taskId: "t3" }, [{ errorId: 0, status: "processing" }, { errorId: 0, status: "ready", solution: { gRecaptchaResponse: "LATE" } }]);
		const token = await solveViaCapSolver({ CAPSOLVER_API_KEY: "cap" } as any, "recaptcha_v2", CHALLENGE, { ...FAST, fetchImpl });
		expect(token).toBe("LATE");
	});

	it("returns null on a createTask error and on a failed solve", async () => {
		const bad = capSolverFetch({ errorId: 1, errorCode: "ERROR_KEY_DENIED" }, []);
		expect(await solveViaCapSolver({ CAPSOLVER_API_KEY: "cap" } as any, "recaptcha_v2", CHALLENGE, { ...FAST, fetchImpl: bad })).toBeNull();
		const failed = capSolverFetch({ errorId: 0, taskId: "t4" }, [{ errorId: 0, status: "failed" }]);
		expect(await solveViaCapSolver({ CAPSOLVER_API_KEY: "cap" } as any, "recaptcha_v2", CHALLENGE, { ...FAST, fetchImpl: failed })).toBeNull();
	});
});

const CREDS_ENV = { CREDIT_KARMA_USERNAME: "alice@example.com", CREDIT_KARMA_PASSWORD: "s3cret", CAPSOLVER_API_KEY: "cap" } as any;

function fakeSession(result: CfSessionResult): { run: (env: any, spec: CfSessionSpec) => Promise<CfSessionResult>; spec: () => CfSessionSpec } {
	let captured: CfSessionSpec | undefined;
	return {
		run: async (_env, spec) => {
			captured = spec;
			return result;
		},
		spec: () => captured!,
	};
}

describe("runPortalScrape", () => {
	it("drives the config's login steps with credentials from named secrets", async () => {
		const s = fakeSession({ ok: true, contentType: "text/html", body: "<html>your credit score</html>", text: "your credit score", fields: { score: "742" }, finalUrl: "https://x", stepsRun: 5 });
		await runPortalScrape(CREDS_ENV, "credit_karma", { runSession: s.run });
		const spec = s.spec();
		expect(spec.start_url).toBe(CREDIT_KARMA.login_url);
		const typeSteps = spec.steps.filter((x) => x.action === "type") as Array<{ value: string }>;
		expect(typeSteps.map((x) => x.value)).toContain("alice@example.com");
		expect(typeSteps.map((x) => x.value)).toContain("s3cret");
		// credentials substituted — the literal field name never leaks into a step value
		expect(typeSteps.map((x) => x.value)).not.toContain("username");
		expect(spec.steps.some((x) => x.action === "solve_captcha")).toBe(true);
		expect(spec.steps.some((x) => x.action === "click")).toBe(true);
		expect(spec.steps.some((x) => x.action === "wait_for")).toBe(true);
	});

	it("returns not_configured (never opens a session) when credentials are missing", async () => {
		const s = fakeSession({ ok: true, contentType: "text/html", body: "", text: "", fields: {}, finalUrl: "", stepsRun: 0 });
		const runSpy = vi.fn(s.run);
		const r = await runPortalScrape({} as any, "credit_karma", { runSession: runSpy });
		expect(r.status).toBe("not_configured");
		expect(r.message).toMatch(/CREDIT_KARMA_USERNAME/);
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("extracts the scraped fields into a structured note body", async () => {
		const s = fakeSession({ ok: true, contentType: "text/html", body: "<html>your credit score</html>", text: "your credit score", fields: { score: "742", bureau: "TransUnion" }, finalUrl: "https://x", stepsRun: 5 });
		const r = await runPortalScrape(CREDS_ENV, "credit_karma", { runSession: s.run });
		expect(r.status).toBe("ok");
		expect(r.title).toBe("Credit Karma score");
		expect(r.body).toContain("742");
		expect(r.body).toContain("TransUnion");
		expect(r.tags).toContain("credit");
	});

	it("reports needs_reauth when login lands on an MFA/verification page", async () => {
		const s = fakeSession({ ok: true, contentType: "text/html", body: "<html>We sent a code. Enter the code.</html>", text: "We sent a code. Enter the code.", fields: {}, finalUrl: "https://x", stepsRun: 5 });
		const r = await runPortalScrape(CREDS_ENV, "credit_karma", { runSession: s.run });
		expect(r.status).toBe("needs_reauth");
		expect(r.message).toMatch(/re-auth|MFA/i);
	});

	it("reports needs_reauth from a failed-session snapshot too", async () => {
		const s = fakeSession({ ok: false, error: "session failed at step 5: timeout", text: "verify it's you", stepsRun: 4 });
		const r = await runPortalScrape(CREDS_ENV, "credit_karma", { runSession: s.run });
		expect(r.status).toBe("needs_reauth");
	});

	it("reports bot_wall on an access-denied page", async () => {
		const s = fakeSession({ ok: true, contentType: "text/html", body: "<html>Access Denied — unusual activity</html>", text: "Access Denied — unusual activity", fields: {}, finalUrl: "https://x", stepsRun: 5 });
		const r = await runPortalScrape(CREDS_ENV, "credit_karma", { runSession: s.run });
		expect(r.status).toBe("bot_wall");
	});

	it("reports layout_change when logged in but no field matched", async () => {
		const s = fakeSession({ ok: true, contentType: "text/html", body: "<html>your credit score dashboard</html>", text: "your credit score dashboard", fields: {}, finalUrl: "https://x", stepsRun: 5 });
		const r = await runPortalScrape(CREDS_ENV, "credit_karma", { runSession: s.run });
		expect(r.status).toBe("layout_change");
	});

	it("falls back to an LLM extraction pass when selectors miss", async () => {
		const s = fakeSession({ ok: true, contentType: "text/html", body: "<html>your credit score is 700</html>", text: "your credit score is 700", fields: {}, finalUrl: "https://x", stepsRun: 5 });
		const llmExtract = vi.fn(async () => ({ score: "700" }));
		const r = await runPortalScrape(CREDS_ENV, "credit_karma", { runSession: s.run, llmExtract });
		expect(r.status).toBe("ok");
		expect(r.body).toContain("700");
		expect(llmExtract).toHaveBeenCalled();
	});

	it("fails honestly (no hang) on a bare session error", async () => {
		const s = fakeSession({ ok: false, error: "session failed at step 5: waiting for selector `#dashboard` failed: timeout", stepsRun: 4 });
		const r = await runPortalScrape(CREDS_ENV, "credit_karma", { runSession: s.run });
		expect(r.status).toBe("error");
		expect(r.message).toMatch(/scrape failed/);
	});

	it("returns error for an unknown source", async () => {
		const r = await runPortalScrape(CREDS_ENV, "does_not_exist", {});
		expect(r.status).toBe("error");
		expect(r.message).toMatch(/Unknown portal source/);
	});
});

describe("studentaid.gov / federal-FSA exclusion", () => {
	it("recognizes studentaid.gov and its subdomains as excluded", () => {
		expect(isExcludedPortalHost("https://studentaid.gov/fsa-id/sign-in")).toBe(true);
		expect(isExcludedPortalHost("https://fsa.studentaid.gov/login")).toBe(true);
		expect(isExcludedPortalHost("https://www.creditkarma.com/auth/logon")).toBe(false);
		// a malformed value that still embeds the host trips the fail-safe substring check
		expect(isExcludedPortalHost("studentaid.gov login")).toBe(true);
	});

	afterEach(() => {
		delete PORTAL_SOURCES.__test_fsa;
	});

	it("refuses to drive an excluded-host source before creds or a browser session", async () => {
		PORTAL_SOURCES.__test_fsa = {
			name: "__test_fsa",
			label: "Federal Student Aid",
			login_url: "https://studentaid.gov/fsa-id/sign-in",
			secret_prefix: "FSA",
			steps: [],
		};
		const runSpy = vi.fn(async () => ({ ok: true, contentType: "text/html", body: "", text: "", fields: {}, finalUrl: "", stepsRun: 0 }) as CfSessionResult);
		const r = await runPortalScrape(CREDS_ENV, "__test_fsa", { runSession: runSpy });
		expect(r.status).toBe("blocked_source");
		expect(r.message).toMatch(/studentaid\.gov|federal FSA|MyStudentData/i);
		expect(runSpy).not.toHaveBeenCalled();
	});
});
