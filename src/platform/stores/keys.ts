/**
 * Platform signing keys, persisted (private half encrypted with APP_SECRET) so
 * every instance and restart signs with the same key and the JWKS stays stable.
 */
import { desc, eq, gt, or } from "drizzle-orm";
import type { JWK } from "jose";
import { decrypt, encrypt } from "@/src/crypto";
import { db } from "@/src/db/client";
import { signingKeys } from "@/src/db/schema";
import { generateSigningKey, type SigningKey } from "./jwt-sign";

let cached: SigningKey | undefined;

export async function activeSigningKey(): Promise<SigningKey> {
	if (cached) return cached;
	const [row] = await db()
		.select()
		.from(signingKeys)
		.where(eq(signingKeys.active, true))
		.orderBy(desc(signingKeys.createdAt))
		.limit(1);
	if (row) {
		cached = { kid: row.kid, privateJwk: JSON.parse(decrypt(row.privateJwkEnc)), publicJwk: row.publicJwk as JWK };
		return cached;
	}
	const key = await generateSigningKey();
	await db()
		.insert(signingKeys)
		.values({ kid: key.kid, privateJwkEnc: encrypt(JSON.stringify(key.privateJwk)), publicJwk: key.publicJwk })
		.onConflictDoNothing();
	cached = key;
	return key;
}

/** Active key plus keys retired in the last 24 h, so tokens signed just before a rotation still verify. */
export async function publicJwks(): Promise<{ keys: JWK[] }> {
	const dayAgo = new Date(Date.now() - 86_400_000);
	const rows = await db()
		.select({ jwk: signingKeys.publicJwk })
		.from(signingKeys)
		.where(or(eq(signingKeys.active, true), gt(signingKeys.createdAt, dayAgo)));
	return { keys: rows.map((r) => r.jwk as JWK) };
}
