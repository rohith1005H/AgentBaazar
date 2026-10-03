import { importJWK, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { AuthError, setLocalJwks, verifyCartJwt } from "@/src/merchant/auth/jwt-verify";
import { generateSigningKey, jwks, type SigningKey, signCartJwt } from "./jwt-sign";

const ISSUER = "https://agentbaazar.test";
const bearer = (t: string) => `Bearer ${t}`;

/** A token shaped exactly like PayPal's documented example: no aud, iss or sub. */
async function paypalShaped(key: SigningKey, claims: Record<string, unknown>, expSeconds = 600) {
	return new SignJWT(claims)
		.setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
		.setIssuedAt()
		.setExpirationTime(`${expSeconds}s`)
		.sign(await importJWK(key.privateJwk, "RS256"));
}

describe("verifyCartJwt", () => {
	afterEach(() => setLocalJwks(undefined));

	it("accepts our platform's token and reports the merchant it was issued for", async () => {
		const key = await generateSigningKey();
		setLocalJwks(jwks([key]));
		const caller = await verifyCartJwt(bearer(await signCartJwt(key, "patel-textiles", ISSUER)));
		expect(caller).toMatchObject({ merchantId: "patel-textiles", subject: ISSUER });
		expect(caller.payload.scope).toEqual(["cart"]);
	});

	it("accepts PayPal's documented token shape { merchant_id, scope, iat, exp }", async () => {
		const key = await generateSigningKey();
		setLocalJwks(jwks([key]));
		const token = await paypalShaped(key, { merchant_id: "MERCHANT-123", scope: ["cart"] });
		expect(await verifyCartJwt(bearer(token))).toMatchObject({ merchantId: "MERCHANT-123", subject: "paypal" });
	});

	it("rejects a token without merchant_id or without the cart scope", async () => {
		const key = await generateSigningKey();
		setLocalJwks(jwks([key]));
		await expect(verifyCartJwt(bearer(await paypalShaped(key, { scope: ["cart"] })))).rejects.toMatchObject({
			status: 403,
		});
		await expect(
			verifyCartJwt(bearer(await paypalShaped(key, { merchant_id: "M", scope: ["orders"] }))),
		).rejects.toMatchObject({
			status: 403,
		});
	});

	it("rejects a token signed by an unknown key", async () => {
		const trusted = await generateSigningKey();
		const rogue = await generateSigningKey();
		setLocalJwks(jwks([trusted]));
		await expect(verifyCartJwt(bearer(await signCartJwt(rogue, "patel-textiles", ISSUER)))).rejects.toBeInstanceOf(
			AuthError,
		);
	});

	it("rejects an expired token (beyond the 60 s skew)", async () => {
		const key = await generateSigningKey();
		setLocalJwks(jwks([key]));
		await expect(verifyCartJwt(bearer(await signCartJwt(key, "patel-textiles", ISSUER, -120)))).rejects.toBeInstanceOf(
			AuthError,
		);
	});

	it("rejects alg=none and a missing header", async () => {
		const key = await generateSigningKey();
		setLocalJwks(jwks([key]));
		const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"merchant_id":"m","scope":["cart"],"exp":9999999999}').toString("base64url")}.`;
		await expect(verifyCartJwt(bearer(none))).rejects.toBeInstanceOf(AuthError);
		await expect(verifyCartJwt(null)).rejects.toMatchObject({ status: 401 });
	});
});
