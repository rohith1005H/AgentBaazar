/**
 * Platform signing keys, persisted (private half encrypted with APP_SECRET) so
 * every instance and restart signs with the same key and the JWKS stays stable.
 *
 * If APP_SECRET changes, the stored key can no longer be decrypted: it is retired
 * (its public half stays published for 24 h) and a new key is issued.
 */
import { and, desc, eq, gt, or } from "drizzle-orm";
import type { JWK } from "jose";
import { decrypt, encrypt } from "@/src/crypto";
import { db } from "@/src/db/client";
import { signingKeys } from "@/src/db/schema";
import { log } from "@/src/log";
import { generateSigningKey, type SigningKey } from "./jwt-sign";

const GRACE_MS = 86_400_000;
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
		try {
			cached = { kid: row.kid, privateJwk: JSON.parse(decrypt(row.privateJwkEnc)), publicJwk: row.publicJwk as JWK };
			return cached;
		} catch {
			log.warn({ kid: row.kid }, "signing key cannot be decrypted with the current APP_SECRET; rotating");
			await retire(row.kid);
		}
	}
	const key = await generateSigningKey();
	await db()
		.insert(signingKeys)
		.values({ kid: key.kid, privateJwkEnc: encrypt(JSON.stringify(key.privateJwk)), publicJwk: key.publicJwk })
		.onConflictDoNothing();
	cached = key;
	return key;
}

export async function retire(kid: string): Promise<void> {
	await db()
		.update(signingKeys)
		.set({ active: false, retiredAt: new Date() })
		.where(and(eq(signingKeys.kid, kid), eq(signingKeys.active, true)));
	if (cached?.kid === kid) cached = undefined;
}

/** Active keys plus keys retired in the last 24 h, so tokens signed just before a rotation still verify. */
export async function publicJwks(): Promise<{ keys: JWK[] }> {
	const rows = await db()
		.select({ jwk: signingKeys.publicJwk })
		.from(signingKeys)
		.where(or(eq(signingKeys.active, true), gt(signingKeys.retiredAt, new Date(Date.now() - GRACE_MS))));
	return { keys: rows.map((r) => r.jwk as JWK) };
}
