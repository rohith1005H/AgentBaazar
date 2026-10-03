import { afterEach, describe, expect, it } from "vitest";
import { AuthError, useLocalJwks, verifyCartJwt } from "@/src/merchant/auth/jwt-verify";
import { generateSigningKey, jwks, signCartJwt } from "./jwt-sign";

const ISSUER = "https://agentbaazar.test";

describe("platform signs, merchant verifies", () => {
	afterEach(() => useLocalJwks(undefined));

	it("round-trips a cart JWT for the right merchant", async () => {
		const key = await generateSigningKey();
		useLocalJwks(jwks([key]));
		const token = await signCartJwt(key, "patel-textiles", ISSUER);
		const caller = await verifyCartJwt(`Bearer ${token}`, "patel-textiles");
		expect(caller.merchantId).toBe("patel-textiles");
		expect(caller.payload.scope).toEqual(["cart"]);
	});

	it("rejects a token meant for another merchant", async () => {
		const key = await generateSigningKey();
		useLocalJwks(jwks([key]));
		const token = await signCartJwt(key, "patel-textiles", ISSUER);
		await expect(verifyCartJwt(`Bearer ${token}`, "lumen-ceramics")).rejects.toBeInstanceOf(AuthError);
	});

	it("rejects a token signed by an unknown key", async () => {
		const trusted = await generateSigningKey();
		const rogue = await generateSigningKey();
		useLocalJwks(jwks([trusted]));
		const token = await signCartJwt(rogue, "patel-textiles", ISSUER);
		await expect(verifyCartJwt(`Bearer ${token}`, "patel-textiles")).rejects.toBeInstanceOf(AuthError);
	});

	it("rejects an expired token", async () => {
		const key = await generateSigningKey();
		useLocalJwks(jwks([key]));
		const token = await signCartJwt(key, "patel-textiles", ISSUER, -120); // expired 2 min ago, beyond 60 s tolerance
		await expect(verifyCartJwt(`Bearer ${token}`, "patel-textiles")).rejects.toBeInstanceOf(AuthError);
	});

	it("rejects a missing header", async () => {
		await expect(verifyCartJwt(null, "patel-textiles")).rejects.toMatchObject({ status: 401 });
	});
});
