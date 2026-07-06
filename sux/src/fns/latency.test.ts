import { describe, expect, it, vi } from "vitest";

import { smartFetch } from "../proxy";

// Mock the residential proxy so the test is offline & deterministic.
vi.mock("../proxy", () => ({
	smartFetch: vi.fn(async () => new Response(null, { status: 200 })),
}));

import { latency } from "./latency";

describe("latency", () => {
	it("rejects non-http urls", async () => {
		const r = await latency.run({} as any, { url: "ftp://x" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/absolute http/);
	});

	it("times the requested number of samples with HEAD", async () => {
		const mock = vi.mocked(smartFetch);
		mock.mockClear();
		mock.mockResolvedValue(new Response(null, { status: 200 }));
		const r = await latency.run({} as any, { url: "https://x.com", samples: 4 });
		expect(r.isError).toBeFalsy();
		const j = JSON.parse(r.content[0].text);
		expect(j.samples).toBe(4);
		expect(mock).toHaveBeenCalledTimes(4);
		expect(mock.mock.calls[0][2]).toMatchObject({ method: "HEAD" });
		expect(typeof j.min_ms).toBe("number");
		expect(typeof j.max_ms).toBe("number");
		expect(typeof j.avg_ms).toBe("number");
		expect(j.min_ms).toBeLessThanOrEqual(j.max_ms);
	});

	it("clamps an out-of-range sample count to 20", async () => {
		const mock = vi.mocked(smartFetch);
		mock.mockClear();
		mock.mockResolvedValue(new Response(null, { status: 200 }));
		const r = await latency.run({} as any, { url: "https://x.com", samples: 999 });
		const j = JSON.parse(r.content[0].text);
		expect(j.samples).toBe(20);
		expect(mock).toHaveBeenCalledTimes(20);
	});

	it("surfaces a probe failure", async () => {
		vi.mocked(smartFetch).mockRejectedValueOnce(new Error("boom"));
		const r = await latency.run({} as any, { url: "https://x.com", samples: 3 });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/Probe 1 failed/);
	});
});
