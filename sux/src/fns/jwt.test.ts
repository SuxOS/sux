import { describe, expect, it } from "vitest";
import { jwt } from "./jwt";

const b64url = (bytes: Uint8Array): string =>
	btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (obj: unknown): string => b64url(new TextEncoder().encode(JSON.stringify(obj)));

async function sign(header: unknown, payload: unknown, secret: string): Promise<string> {
	const data = `${enc(header)}.${enc(payload)}`;
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
	return `${data}.${b64url(sig)}`;
}

describe("jwt", () => {
	it("decodes claims and flags expiry", async () => {
		const token = await sign({ alg: "HS256", typ: "JWT" }, { sub: "42", exp: 1 }, "irrelevant"); // exp in 1970 -> expired
		const r = await jwt.run({} as any, { token });
		const out = JSON.parse(r.content[0].text);
		expect(out.payload.sub).toBe("42");
		expect(out.expired).toBe(true);
		expect(out.signature_valid).toBeUndefined(); // no secret -> not verified
	});

	it("verifies a correct HS256 signature", async () => {
		const token = await sign({ alg: "HS256", typ: "JWT" }, { sub: "ok" }, "s3cret");
		const good = JSON.parse((await jwt.run({} as any, { token, secret: "s3cret" })).content[0].text);
		expect(good.signature_valid).toBe(true);
		const bad = JSON.parse((await jwt.run({} as any, { token, secret: "wrong" })).content[0].text);
		expect(bad.signature_valid).toBe(false);
	});

	it("rejects a non-JWT string", async () => {
		const r = await jwt.run({} as any, { token: "not-a-jwt" });
		expect(r.isError).toBe(true);
	});

	it("errors when verifying a non-HS256 token", async () => {
		const token = await sign({ alg: "RS256", typ: "JWT" }, { sub: "x" }, "unused");
		const r = await jwt.run({} as any, { token, secret: "any" });
		expect(r.isError).toBe(true);
		expect(r.content[0].text).toMatch(/HS256 only/);
	});
});
