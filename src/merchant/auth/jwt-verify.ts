/**
 * Merchant side: verify the platform-supplied JWT on every Cart API call.
 *
 * AGENTIC_JWKS_URL   where the caller's public keys live.
 *                    Demo: our own platform JWKS. Real PayPal Store Sync:
 *                    https://www.paypal.ai/.well-known/jwks.json
 * AGENTIC_AUDIENCE   optional fixed audience; otherwise the merchant id from the route.
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
export function useLocalJwks(jwks: Parameters<typeof createLocalJWKSet>[0] | undefined): void {
	cached = jwks ? { url: "local", verifier: createLocalJWKSet(jwks) } : undefined;
}

export type CartCaller = { payload: JWTPayload; merchantId: string; subject: string };

export async function verifyCartJwt(authorization: string | null, expectedMerchantId: string): Promise<CartCaller> {
	const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
	if (!token) throw new AuthError("Missing bearer token");
	try {
		const { payload } = await jwtVerify(token, verifier(), {
			audience: process.env.AGENTIC_AUDIENCE ?? expectedMerchantId,
			issuer: process.env.JWT_ISSUER || undefined,
			clockTolerance: 60,
		});
		const scope = payload.scope;
		const scopes = Array.isArray(scope) ? scope : typeof scope === "string" ? scope.split(" ") : [];
		if (!scopes.includes("cart")) throw new AuthError("Token lacks cart scope", 403);
		return {
			payload,
			merchantId: String(payload.merchant_id ?? expectedMerchantId),
			subject: payload.sub ?? "unknown",
		};
	} catch (e) {
		if (e instanceof AuthError) throw e;
		throw new AuthError(`Invalid token: ${(e as Error).message}`);
	}
}
