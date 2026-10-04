/**
 * AES-256-GCM for secrets we must store (per-merchant PayPal secrets, platform
 * signing keys). Key = APP_SECRET (32 bytes, hex). Format: base64(iv|tag|ciphertext).
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

function key(): Buffer {
	const hex = process.env.APP_SECRET;
	if (!hex || !/^[0-9a-f]{64}$/i.test(hex))
		throw new Error("APP_SECRET must be 32 bytes of hex (openssl rand -hex 32)");
	return Buffer.from(hex, "hex");
}

export function encrypt(plain: string): string {
	const iv = randomBytes(12);
	const c = createCipheriv("aes-256-gcm", key(), iv);
	const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
	return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function decrypt(blob: string): string {
	const raw = Buffer.from(blob, "base64");
	const d = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, 12));
	d.setAuthTag(raw.subarray(12, 28));
	return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}

/** Short HMAC for shareable links (e.g. an order review page) so ids cannot be enumerated. */
export function signLink(value: string): string {
	return createHmac("sha256", key()).update(value).digest("base64url").slice(0, 22);
}

export function verifyLink(value: string, sig: string | null | undefined): boolean {
	if (!sig) return false;
	const want = Buffer.from(signLink(value));
	const got = Buffer.from(sig);
	return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * A UUID-shaped PayPal-Request-Id derived from a key (e.g. "CART-...-authorize"): the same
 * operation always sends the same id, and it stays within PayPal's length limits.
 */
export function stableRequestId(key: string): string {
	const h = createHash("sha256").update(key).digest("hex");
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
