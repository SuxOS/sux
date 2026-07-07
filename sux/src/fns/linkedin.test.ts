import { afterEach, describe, expect, it, vi } from "vitest";
import { linkedin } from "./linkedin";

afterEach(() => vi.unstubAllGlobals());

const ENV = { PROXYCURL_API_KEY: "k" } as any;

describe("linkedin", () => {
	it("reports when PROXYCURL_API_KEY is not configured", async () => {
		const r = await linkedin.run({} as any, { url: "https://www.linkedin.com/in/x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/PROXYCURL_API_KEY/);
	});

	it("rejects a non-linkedin url", async () => {
		const r = await linkedin.run(ENV, { url: "https://example.com/in/x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/linkedin\.com/);
	});

	it("resolves a person profile and distills Proxycurl's verbose payload", async () => {
		const payload = {
			full_name: "Ada Lovelace",
			headline: "Mathematician",
			occupation: "Analyst at X",
			city: "London",
			country_full_name: "UK",
			experiences: [{ title: "Analyst", company: "X", starts_at: { year: 2020 } }, { title: "Old", company: "Y" }, { title: "Older", company: "Z" }, { title: "Oldest", company: "W" }],
			education: [{ school: "Uni", degree_name: "BS", field_of_study: "Math" }],
			skills: Array.from({ length: 30 }, (_, i) => `skill${i}`),
			public_identifier: "ada",
		};
		const fetchMock = vi.fn(async (u: string | URL, _init?: RequestInit) => {
			expect(String(u)).toContain("/v2/linkedin?linkedin_profile_url=");
			return new Response(JSON.stringify(payload), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await linkedin.run(ENV, { url: "https://www.linkedin.com/in/ada" });
		const out = JSON.parse(r.content[0].text);
		expect(out.full_name).toBe("Ada Lovelace");
		expect(out.current).toHaveLength(3); // capped
		expect(out.skills).toHaveLength(15); // capped
		expect(out.profile_url).toBe("https://www.linkedin.com/in/ada");
		// Bearer auth sent
		expect((fetchMock.mock.calls[0][1] as any).headers.Authorization).toBe("Bearer k");
	});

	it("resolves a company via the company endpoint", async () => {
		const fetchMock = vi.fn(async (u: string | URL) => {
			expect(String(u)).toContain("/linkedin/company?url=");
			return new Response(JSON.stringify({ name: "Acme", industry: "Tech", follower_count: 100 }), { status: 200 });
		});
		vi.stubGlobal("fetch", fetchMock);
		const r = await linkedin.run(ENV, { url: "https://www.linkedin.com/company/acme", action: "company" });
		expect(JSON.parse(r.content[0].text)).toMatchObject({ name: "Acme", industry: "Tech", followers: 100 });
	});

	it("surfaces a Proxycurl error", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ description: "Profile not found" }), { status: 404 })));
		const r = await linkedin.run(ENV, { url: "https://www.linkedin.com/in/nobody" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Profile not found/);
	});
});
