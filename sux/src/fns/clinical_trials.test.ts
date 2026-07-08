import { afterEach, describe, expect, it, vi } from "vitest";
import { clinical_trials } from "./clinical_trials";

const BODY = {
	studies: [
		{
			protocolSection: {
				identificationModule: { nctId: "NCT01234567", briefTitle: "A Study of Widget Therapy" },
				statusModule: { overallStatus: "RECRUITING" },
				conditionsModule: { conditions: ["Diabetes", "Obesity"] },
				designModule: { phases: ["PHASE2", "PHASE3"] },
			},
		},
	],
};

afterEach(() => vi.restoreAllMocks());

describe("clinical_trials", () => {
	it("normalizes studies into { nct_id, title, status, conditions, phases, url }", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		const r = await clinical_trials.run({} as any, { term: "diabetes", page_size: 5 });
		const out = JSON.parse(r.content[0].text);
		expect(out.count).toBe(1);
		const e = out.results[0];
		expect(e.nct_id).toBe("NCT01234567");
		expect(e.title).toBe("A Study of Widget Therapy");
		expect(e.status).toBe("RECRUITING");
		expect(e.conditions).toEqual(["Diabetes", "Obesity"]);
		expect(e.phases).toEqual(["PHASE2", "PHASE3"]);
		expect(e.url).toBe("https://clinicaltrials.gov/study/NCT01234567");
	});

	it("passes term and page_size to the API", async () => {
		const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(BODY), { status: 200 }));
		await clinical_trials.run({} as any, { term: "lung cancer", page_size: 9 });
		const url = String(spy.mock.calls[0][0]);
		expect(url).toContain("query.term=lung+cancer");
		expect(url).toContain("pageSize=9");
		expect(url).toContain("format=json");
	});

	it("errors without a term", async () => {
		const r = await clinical_trials.run({} as any, {});
		expect(r.isError).toBe(true);
	});

	it("fails on an HTTP error", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
		const r = await clinical_trials.run({} as any, { term: "x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/503/);
	});
});
