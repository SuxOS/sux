import { afterEach, describe, expect, it, vi } from "vitest";
import { clinical_trials } from "./clinical_trials";

afterEach(() => vi.unstubAllGlobals());

const STUDY = {
	protocolSection: {
		identificationModule: { nctId: "NCT01", briefTitle: "CAR-T for glioblastoma" },
		statusModule: { overallStatus: "RECRUITING", startDateStruct: { date: "2024-01" } },
		designModule: { phases: ["PHASE1", "PHASE2"], enrollmentInfo: { count: 40 } },
		conditionsModule: { conditions: ["Glioblastoma", "Brain Cancer"] },
	},
};

describe("clinical_trials", () => {
	it("rejects an empty query", async () => {
		const r = await clinical_trials.run({} as any, { query: "" });
		expect(r.isError).toBe(true);
	});

	it("distills studies into a citable list", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ studies: [STUDY] }), { status: 200 })));
		const r = await clinical_trials.run({} as any, { query: "glioblastoma" });
		const t = r.content[0].text;
		expect(t).toContain("CAR-T for glioblastoma");
		expect(t).toContain("NCT01");
		expect(t).toContain("RECRUITING");
		expect(t).toContain("phase PHASE1/PHASE2");
		expect(t).toContain("n=40");
	});

	it("passes the status filter through", async () => {
		const spy = vi.fn(async (u: string) => {
			expect(u).toContain("filter.overallStatus=COMPLETED");
			return new Response(JSON.stringify({ studies: [STUDY] }), { status: 200 });
		});
		vi.stubGlobal("fetch", spy);
		await clinical_trials.run({} as any, { query: "x", status: "completed" });
		expect(spy).toHaveBeenCalled();
	});

	it("reports no results cleanly", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ studies: [] }), { status: 200 })));
		const r = await clinical_trials.run({} as any, { query: "zzz" });
		expect(r.isError).toBeFalsy();
		expect(r.content[0].text).toMatch(/No trials/);
	});
});
