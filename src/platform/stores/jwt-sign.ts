/**
 * The platform side signs a short-lived RS256 JWT for every call to a merchant's
 * Cart API, exactly as PayPal's Shopping Cart service does for Store Sync
 * merchants. Merchants verify it against our JWKS; swapping the JWKS URL to
 * PayPal's is what turns a demo store into a real Store Sync merchant.
 *
 * Claims: iss, aud (merchant id), merchant_id, scope ["cart"], iat, exp, jti.
 */
import { randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose";

export type SigningKey = { kid: string; privateJwk: JWK; publicJwk: JWK };

export async function generateSigningKey(): Promise<SigningKey> {
	const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
	const kid = randomUUID();
	const [privateJwk, publicJwk] = await Promise.all([exportJWK(privateKey), exportJWK(publicKey)]);
	return {
		kid,
		privateJwk: { ...privateJwk, kid, alg: "RS256", use: "sig" },
		publicJwk: { ...publicJwk, kid, alg: "RS256", use: "sig" },
	};
}

export async function signCartJwt(
	key: SigningKey,
	merchantId: string,
	issuer: string,
	ttlSeconds = 600,
	/** Opaque per-buyer-session id, so the store can rate limit buyers separately */
	sid?: string,
): Promise<string> {
	const pk = await importJWK(key.privateJwk, "RS256");
	return new SignJWT({ merchant_id: merchantId, scope: ["cart"], ...(sid && { sid }) })
		.setProtectedHeader({ alg: "RS256", kid: key.kid, typ: "JWT" })
		.setIssuer(issuer)
		.setAudience(merchantId)
		.setSubject(issuer)
		.setJti(randomUUID())
		.setIssuedAt()
		.setExpirationTime(`${ttlSeconds}s`)
		.sign(pk);
}

/** JWKS document served at /.well-known/jwks.json */
export function jwks(keys: SigningKey[]): { keys: JWK[] } {
	return { keys: keys.map((k) => k.publicJwk) };
}
