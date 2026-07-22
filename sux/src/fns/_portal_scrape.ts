// Credentialed-portal scraper (#portal-scraper) — the generic mechanism for
// pulling data out of a login-gated source that has NO API: credit-score
// providers, loan servicers, utility portals, anything behind a username +
// password (+ a bot-wall CAPTCHA). One config per source; the engine is shared.
//
// Pipeline:
//   1. resolve credentials from named secrets (<PREFIX>_USERNAME/_PASSWORD) —
//      NEVER from code or the request; absent ⇒ not_configured.
//   2. drive a credentialed browser session via cf-render's cfRenderSession
//      (residential home-IP egress + stealth — the render escalation stack), running
//      the config's login steps.
//   3. solve any CAPTCHA/bot-wall with CapSolver (submit challenge → poll for token
//      → inject), gated on CAPSOLVER_API_KEY.
//   4. extract the target data by CSS selectors (deterministic, preferred) with an
//      optional LLM pass over the rendered text as a fallback.
//   5. hand a structured markdown note back to the caller (ingest writes it to the
//      vault so the oracle tracks it over time).
//
// Fragile by nature: MFA prompts, session expiry and bot walls are DETECTED and
// reported as an honest status (needs_reauth / bot_wall) — never faked as success,
// never left to hang (every browser wait has a timeout).
//
// HARD EXCLUSION: studentaid.gov and the federal FSA login are refused here (see
// EXCLUDED_HOSTS). That account has mandatory per-session MFA + Akamai Bot Manager
// (CapSolver can't mint the _abck sensor) and, critically, is a FEDERAL account
// where a tripped bot heuristic LOCKS the FSA ID and gates FAFSA/PSLF. The federal
// path is the MyStudentData.txt file ingest (sux#1323), not scraping.

import type { RtEnv } from "../registry";
import { type CaptchaChallenge, type CaptchaSolver, type CfSessionResult, type CfSessionSpec, type SessionStep, cfRenderSession } from "../cf-render";
import { looksBlocked } from "../retail-render";
import { hasAI, llm } from "../ai";

// --- CapSolver client ------------------------------------------------------
//
// API shape (verified against docs.capsolver.com, 2026-07): POST createTask with
// {clientKey, task:{type, websiteURL, websiteKey, ...}} → {errorId, taskId}; then
// poll POST getTaskResult with {clientKey, taskId} until status==="ready" (or
// "failed"). The token is solution.gRecaptchaResponse (reCAPTCHA/hCaptcha) or
// solution.token (Turnstile). errorId !== 0 anywhere ⇒ failure.

const CAPSOLVER_CREATE_URL = "https://api.capsolver.com/createTask";
const CAPSOLVER_RESULT_URL = "https://api.capsolver.com/getTaskResult";

export type CaptchaProvider = "recaptcha_v2" | "hcaptcha" | "turnstile";

const CAPSOLVER_TASK_TYPE: Record<CaptchaProvider, string> = {
	recaptcha_v2: "ReCaptchaV2TaskProxyLess",
	hcaptcha: "HCaptchaTaskProxyLess",
	turnstile: "AntiTurnstileTaskProxyLess",
};

export type CapSolverOpts = {
	pollIntervalMs?: number;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
};

function taskFor(provider: CaptchaProvider, challenge: CaptchaChallenge): Record<string, unknown> {
	const base = { type: CAPSOLVER_TASK_TYPE[provider], websiteURL: challenge.websiteUrl, websiteKey: challenge.siteKey };
	return provider === "recaptcha_v2" ? { ...base, isInvisible: false } : base;
}

function tokenFromSolution(solution: any): string | null {
	if (!solution || typeof solution !== "object") return null;
	const t = solution.gRecaptchaResponse ?? solution.token ?? solution.text;
	return typeof t === "string" && t.length > 0 ? t : null;
}

/** Solve one CAPTCHA via CapSolver → token, or null on any failure (never throws).
 *  `provider` names the task type; the challenge carries sitekey + page URL. */
export async function solveViaCapSolver(env: RtEnv, provider: CaptchaProvider, challenge: CaptchaChallenge, opts: CapSolverOpts = {}): Promise<string | null> {
	const clientKey = env.CAPSOLVER_API_KEY;
	if (!clientKey) return null;
	const doFetch = opts.fetchImpl ?? fetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
	const pollInterval = opts.pollIntervalMs ?? 3000;
	const timeout = opts.timeoutMs ?? 120000;

	try {
		const createResp = await doFetch(CAPSOLVER_CREATE_URL, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clientKey, task: taskFor(provider, challenge) }),
		});
		const created: any = await createResp.json().catch(() => ({}));
		if (created?.errorId !== 0 || !created?.taskId) {
			console.warn(`capsolver: createTask failed — ${created?.errorCode ?? created?.errorDescription ?? "no taskId"}`);
			return null;
		}
		const taskId = String(created.taskId);
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			await sleep(pollInterval);
			const pollResp = await doFetch(CAPSOLVER_RESULT_URL, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ clientKey, taskId }),
			});
			const result: any = await pollResp.json().catch(() => ({}));
			if (result?.errorId !== 0) {
				console.warn(`capsolver: getTaskResult error — ${result?.errorCode ?? result?.errorDescription ?? "unknown"}`);
				return null;
			}
			if (result?.status === "ready") return tokenFromSolution(result.solution);
			if (result?.status === "failed") return null;
			// any other status ("processing"/"idle") ⇒ keep polling until the deadline
		}
		console.warn("capsolver: timed out waiting for solution");
		return null;
	} catch (e) {
		console.warn(`capsolver: request failed — ${(e as Error)?.message ?? e}`);
		return null;
	}
}

// --- Source configuration --------------------------------------------------

export type PortalStepConfig =
	| { action: "type"; selector: string; field?: "username" | "password"; value?: string; timeout_ms?: number }
	| { action: "click"; selector: string; timeout_ms?: number }
	| { action: "wait_for"; selector: string; timeout_ms?: number }
	| { action: "wait_ms"; ms: number }
	| { action: "press"; key: string }
	| { action: "solve_captcha"; provider: CaptchaProvider; site_key?: string; site_key_selector?: string; response_selector?: string };

export interface PortalSourceConfig {
	// stable key used to select this source (e.g. ingest({portal:"credit_karma"}))
	name: string;
	label: string;
	login_url: string;
	// <secret_prefix>_USERNAME / <secret_prefix>_PASSWORD name the credentials.
	secret_prefix: string;
	steps: PortalStepConfig[];
	// fieldName -> CSS selector; each field's trimmed text is extracted post-login.
	extract_selectors?: Record<string, string>;
	// optional LLM extraction over the rendered text when selectors miss (best-effort).
	extract_prompt?: string;
	// post-login body substrings: at least one must appear or the result is suspect.
	success_markers?: string[];
	// substrings ⇒ an MFA/verification/re-auth wall (honest needs_reauth, not success).
	mfa_markers?: string[];
	// substrings ⇒ a bot-wall / access-denied / blocked page.
	blocked_markers?: string[];
	tags?: string[];
	note_title?: string;
}

// The reference source: Credit Karma (free VantageScore 3.0 from TransUnion +
// Equifax). CHOSEN over Experian-free and Chase Credit Journey because it's a
// standalone consumer-score site — not gated behind a bank's device-binding +
// mandatory-per-login OTP (Chase Credit Journey lives inside chase.com online
// banking) and not gated behind SSN-based identity re-verification / FICO upsells
// (Experian). Its login is username/password with an occasional reCAPTCHA v2 — the
// exact wall CapSolver is built for — so it exercises the CapSolver path
// meaningfully while staying plausibly automatable.
//
// SELECTORS ARE BEST-EFFORT and MUST be confirmed against the live DOM when Colin
// activates this (Credit Karma's markup changes; there's no public API to pin to).
// On activation: run `render({url:"https://www.creditkarma.com/auth/logon"})` to
// capture the current login DOM and a post-login `render` (or the session's own
// failure snapshot) to update the extract selectors. A selector miss surfaces as
// `layout_change`, not a silent wrong value.
export const CREDIT_KARMA: PortalSourceConfig = {
	name: "credit_karma",
	label: "Credit Karma",
	login_url: "https://www.creditkarma.com/auth/logon",
	secret_prefix: "CREDIT_KARMA",
	steps: [
		{ action: "type", selector: 'input[name="username"], input[type="email"]', field: "username" },
		{ action: "type", selector: 'input[name="password"], input[type="password"]', field: "password" },
		{ action: "solve_captcha", provider: "recaptcha_v2" },
		{ action: "click", selector: 'button[type="submit"], button[data-testid="username-password-submit-btn"]' },
		{ action: "wait_for", selector: '[data-testid="score-hero"], [data-testid="credit-score"], main', timeout_ms: 45000 },
	],
	extract_selectors: {
		score: '[data-testid="score-hero-value"], [data-testid="credit-score-value"]',
		bureau: '[data-testid="score-hero-bureau"], [data-testid="credit-bureau"]',
		change: '[data-testid="score-change"]',
		updated: '[data-testid="score-updated-date"], [data-testid="last-updated"]',
	},
	extract_prompt: "Extract the credit score(s) shown on this Credit Karma dashboard. Return JSON with keys: score (the numeric VantageScore), bureau (TransUnion/Equifax), change (points changed, if shown), updated (date the score was refreshed).",
	success_markers: ["credit score", "vantagescore", "score factors", "your score"],
	mfa_markers: ["verify it's you", "verify its you", "enter the code", "verification code", "we sent a code", "two-step", "one-time passcode", "one-time code", "confirm your identity"],
	blocked_markers: ["access denied", "unusual activity", "are you a robot", "verify you are human", "temporarily blocked", "reference #"],
	tags: ["credit", "finance", "portal", "credit-score"],
	note_title: "Credit Karma score",
};

export const PORTAL_SOURCES: Record<string, PortalSourceConfig> = {
	[CREDIT_KARMA.name]: CREDIT_KARMA,
};

// --- Exclusions (federal FSA / studentaid.gov) -----------------------------

// Host suffixes this capability REFUSES to drive, regardless of any config. See
// the file header: studentaid.gov is a federal account where a tripped bot
// heuristic locks the FSA ID; the sanctioned path is the MyStudentData.txt ingest.
export const EXCLUDED_HOSTS = ["studentaid.gov"];

export function isExcludedPortalHost(url: string): boolean {
	let host: string;
	try {
		host = new URL(url).hostname.toLowerCase();
	} catch {
		// An unparseable URL string: fall back to a substring check so an excluded
		// host embedded in a malformed value still trips the guard (fail safe).
		const lower = String(url).toLowerCase();
		return EXCLUDED_HOSTS.some((h) => lower.includes(h));
	}
	return EXCLUDED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

// --- Orchestration ---------------------------------------------------------

export type PortalStatus = "ok" | "not_configured" | "needs_reauth" | "bot_wall" | "blocked_source" | "layout_change" | "error";

export interface PortalScrapeResult {
	status: PortalStatus;
	source: string;
	title?: string;
	body?: string;
	tags?: string[];
	fields?: Record<string, string | null>;
	message?: string;
}

export type LlmExtract = (env: RtEnv, prompt: string, text: string) => Promise<Record<string, string> | null>;

export interface PortalDeps {
	runSession?: (env: RtEnv, spec: CfSessionSpec) => Promise<CfSessionResult>;
	solveCaptcha?: CaptchaSolver;
	llmExtract?: LlmExtract;
}

function hasAnyMarker(haystack: string, markers?: string[]): boolean {
	if (!markers || markers.length === 0) return false;
	const lower = haystack.toLowerCase();
	return markers.some((m) => lower.includes(m.toLowerCase()));
}

function nonNullFields(fields: Record<string, string | null> | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(fields ?? {})) if (v != null && v !== "") out[k] = v;
	return out;
}

// Default LLM extraction: strip the rendered text to a bounded slice, ask the
// model for JSON keyed as the prompt describes, parse leniently. Best-effort —
// any absence/parse failure returns null so the deterministic path stays primary.
const LLM_EXTRACT_MAX = 8000;
async function defaultLlmExtract(env: RtEnv, prompt: string, text: string): Promise<Record<string, string> | null> {
	if (!hasAI(env)) return null;
	try {
		const sys = `${prompt}\n\nReturn ONLY a compact JSON object of string values. If a value is not present, omit its key.`;
		const raw = await llm(env, sys, text.slice(0, LLM_EXTRACT_MAX), 400, "extracting portal data");
		const m = /\{[\s\S]*\}/.exec(raw);
		if (!m) return null;
		const parsed = JSON.parse(m[0]);
		if (!parsed || typeof parsed !== "object") return null;
		const out: Record<string, string> = {};
		for (const [k, v] of Object.entries(parsed)) if (v != null && String(v).trim()) out[k] = String(v).trim();
		return Object.keys(out).length ? out : null;
	} catch {
		return null;
	}
}

function resolveCreds(env: RtEnv, prefix: string): { username: string; password: string } | null {
	const bag = env as unknown as Record<string, string | undefined>;
	const username = bag[`${prefix}_USERNAME`];
	const password = bag[`${prefix}_PASSWORD`];
	if (!username || !password) return null;
	return { username, password };
}

function buildSteps(config: PortalSourceConfig, creds: { username: string; password: string }): SessionStep[] {
	const steps: SessionStep[] = [];
	for (const s of config.steps) {
		if (s.action === "type") {
			const value = s.field === "username" ? creds.username : s.field === "password" ? creds.password : (s.value ?? "");
			steps.push({ action: "type", selector: s.selector, value, timeout_ms: s.timeout_ms });
		} else if (s.action === "click") {
			steps.push({ action: "click", selector: s.selector, timeout_ms: s.timeout_ms });
		} else if (s.action === "wait_for") {
			steps.push({ action: "wait_for", selector: s.selector, timeout_ms: s.timeout_ms });
		} else if (s.action === "wait_ms") {
			steps.push({ action: "wait_ms", ms: s.ms });
		} else if (s.action === "press") {
			steps.push({ action: "press", key: s.key });
		} else {
			steps.push({ action: "solve_captcha", provider: s.provider, site_key: s.site_key, site_key_selector: s.site_key_selector, response_selector: s.response_selector });
		}
	}
	return steps;
}

function renderPortalNote(config: PortalSourceConfig, fields: Record<string, string>, capturedAt: string): string {
	const lines: string[] = [];
	lines.push(`> Pulled from ${config.label} (${config.login_url}) at ${capturedAt}.`, "");
	lines.push("| field | value |", "| --- | --- |");
	for (const [k, v] of Object.entries(fields)) lines.push(`| ${k} | ${String(v).replace(/\|/g, "\\|")} |`);
	return lines.join("\n");
}

/**
 * Run one credentialed portal scrape end-to-end. Returns a structured result the
 * caller (ingest) turns into a vault note. Never throws. `deps` is injectable so
 * tests can drive the whole pipeline without a real browser or network.
 */
export async function runPortalScrape(env: RtEnv, name: string, deps: PortalDeps = {}): Promise<PortalScrapeResult> {
	const config = PORTAL_SOURCES[name];
	if (!config) return { status: "error", source: name, message: `Unknown portal source '${name}'. Known: ${Object.keys(PORTAL_SOURCES).join(", ") || "(none)"}.` };

	// Federal-FSA / studentaid.gov exclusion — refuse before touching anything.
	if (isExcludedPortalHost(config.login_url)) {
		return { status: "blocked_source", source: name, message: `${config.label} is on the portal-scraper exclusion list (studentaid.gov / federal FSA — mandatory MFA + Akamai; a tripped heuristic locks the FSA ID). Use the MyStudentData.txt file ingest instead.` };
	}

	const creds = resolveCreds(env, config.secret_prefix);
	if (!creds) {
		return { status: "not_configured", source: name, message: `${config.label} credentials not configured. Set ${config.secret_prefix}_USERNAME and ${config.secret_prefix}_PASSWORD (wrangler secret).` };
	}

	const needsCaptcha = config.steps.some((s) => s.action === "solve_captcha");
	const solveCaptcha: CaptchaSolver | undefined = deps.solveCaptcha ?? (env.CAPSOLVER_API_KEY ? (challenge) => solveViaCapSolver(env, (challenge.provider as CaptchaProvider) ?? "recaptcha_v2", challenge) : undefined);

	const spec: CfSessionSpec = {
		start_url: config.login_url,
		steps: buildSteps(config, creds),
		as: "html",
		residential: true,
		stealth: true,
		timeout_ms: 45000,
		extract_selectors: config.extract_selectors,
		solveCaptcha,
	};

	const runSession = deps.runSession ?? cfRenderSession;
	const result = await runSession(env, spec);

	// Failure path: classify from the best-effort snapshot rather than reporting a
	// bare error — MFA and bot-wall are the expected, actionable failure modes.
	if (!result.ok) {
		const snap = `${result.text ?? ""}\n${result.body ?? ""}`;
		if (hasAnyMarker(snap, config.mfa_markers)) return { status: "needs_reauth", source: name, message: `${config.label} needs re-auth / MFA — a verification wall was hit during login. ${result.error}` };
		if (hasAnyMarker(snap, config.blocked_markers) || looksBlocked(result.body)) return { status: "bot_wall", source: name, message: `${config.label} hit a bot wall / access-denied page. ${result.error}` };
		if (needsCaptcha && !solveCaptcha && /captcha/i.test(result.error)) return { status: "bot_wall", source: name, message: `${config.label} presented a CAPTCHA but CapSolver is not configured (CAPSOLVER_API_KEY). ${result.error}` };
		return { status: "error", source: name, message: `${config.label} scrape failed: ${result.error}` };
	}

	// Success path: the session ran, but "ran" can still mean it landed on an MFA
	// or bot-wall page that IS valid HTML — check before trusting the content.
	const snap = `${result.text}\n${result.body}`;
	if (hasAnyMarker(snap, config.mfa_markers)) return { status: "needs_reauth", source: name, message: `${config.label} needs re-auth / MFA — login landed on a verification page.` };
	if (hasAnyMarker(snap, config.blocked_markers) || looksBlocked(result.body)) return { status: "bot_wall", source: name, message: `${config.label} landed on a bot wall / access-denied page.` };

	let fields = nonNullFields(result.fields);
	if (Object.keys(fields).length === 0 && config.extract_prompt) {
		const llmExtract = deps.llmExtract ?? defaultLlmExtract;
		const extracted = await llmExtract(env, config.extract_prompt, result.text || result.body || "");
		if (extracted) fields = extracted;
	}

	if (Object.keys(fields).length === 0) {
		const looksLoggedIn = hasAnyMarker(snap, config.success_markers);
		return {
			status: "layout_change",
			source: name,
			message: looksLoggedIn
				? `${config.label} login looked successful but no data matched the extract selectors — the page layout likely changed. Update ${config.name}'s extract_selectors against the live DOM.`
				: `${config.label} scrape produced no data and no success marker — likely a failed login or a changed page. Confirm credentials and selectors.`,
		};
	}

	const capturedAt = new Date().toISOString();
	return {
		status: "ok",
		source: name,
		title: config.note_title ?? config.label,
		body: renderPortalNote(config, fields, capturedAt),
		tags: config.tags,
		fields: result.fields ?? fields,
	};
}
