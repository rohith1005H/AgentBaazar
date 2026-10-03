/**
 * Merchant side: verify the caller's JWT on every Cart API call.
 *
 * PayPal documents the token as RS256 with claims { merchant_id, scope: ["cart"], iat, exp }
 * (no aud/iss), verified against PayPal's JWKS. So:
 *   - signature, expiry and the "cart" scope are always enforced
 *   - `merchant_id` is required; the route wrapper binds it to the store being called
 *   - `aud` / `iss` are enforced only when configured (our own platform sets them)
 *
 * AGENTIC_JWKS_URL   where the caller's public keys live. Demo: our platform's JWKS.
 *                    Real Store Sync: https://www.paypal.ai/.well-known/jwks.json
 * AGENTIC_AUDIENCE   optional required audience
 * AGENTIC_ISSUER     optional required issuer
 */
import { createLocalJWKSet, createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export class AuthError extends Error {
	constructor(
		message: string,
		public readonly status = 401,
	) {
		super(message);
	}
}

type Verifier = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;
let cached: { url: string; verifier: Verifier } | undefined;

function verifier(): Verifier {
	if (cached?.url === "local") return cached.verifier;
	const url = process.env.AGENTIC_JWKS_URL;
	if (!url) throw new AuthError("AGENTIC_JWKS_URL is not configured", 500);
	if (!cached || cached.url !== url) {
		cached = {
			url,
			verifier: createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 }),
		};
	}
	return cached.verifier;
}

/** For tests: verify against an in-memory JWKS instead of fetching. */
export function setLocalJwks(jwks: Parameters<typeof createLocalJWKSet>[0] | undefined): void {
	cached = jwks ? { url: "local", verifier: createLocalJWKSet(jwks) } : undefined;
}

export type CartCaller = {
	payload: JWTPayload;
	/** The merchant the token was issued for (`merchant_id` claim) */
	merchantId: string;
	/** Who is calling: `sub`, else `iss`, else "paypal" for PayPal's sub-less tokens */
	subject: string;
};

export async function verifyCartJwt(authorization: string | null): Promise<CartCaller> {
	const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (!token) throw new AuthError("Missing bearer token");
	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(token, verifier(), {
			algorithms: ["RS256", "ES256"],
			audience: process.env.AGENTIC_AUDIENCE || undefined,
			issuer: process.env.AGENTIC_ISSUER || undefined,
			requiredClaims: ["exp"],
			clockTolerance: 60,
		}));
	} catch (e) {
		throw new AuthError(`Invalid token: ${(e as Error).message}`);
	}
	const scope = payload.scope;
	const scopes = Array.isArray(scope) ? scope : typeof scope === "string" ? scope.split(" ") : [];
	if (!scopes.includes("cart")) throw new AuthError("Token lacks cart scope", 403);
	if (typeof payload.merchant_id !== "string" || !payload.merchant_id)
		throw new AuthError("Token has no merchant_id claim", 403);
	return { payload, merchantId: payload.merchant_id, subject: payload.sub ?? payload.iss ?? "paypal" };
}
