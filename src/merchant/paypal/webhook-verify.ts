/**
 * PayPal webhook signature verification, the "self verification" method PayPal
 * recommends (no API round trip, and it also works for simulator events):
 *
 *   message = transmissionId | transmissionTime | webhookId | crc32(raw body, decimal)
 *   verify paypal-transmission-sig (SHA256withRSA) with the public key of the
 *   certificate at paypal-cert-url
 *
 * The certificate URL comes from the request, so it must point at PayPal:
 * otherwise anyone could sign a fake event with their own certificate.
 */
import { createPublicKey, verify, X509Certificate } from "node:crypto";
import { crc32 } from "node:zlib";

const CERT_HOSTS = new Set([
	"api.paypal.com",
	"api-m.paypal.com",
	"api.sandbox.paypal.com",
	"api-m.sandbox.paypal.com",
]);

export type WebhookHeaders = {
	transmissionId: string;
	transmissionTime: string;
	transmissionSig: string;
	certUrl: string;
	authAlgo: string;
};

export function readWebhookHeaders(h: Headers): WebhookHeaders | null {
	const get = (n: string) => h.get(n) ?? "";
	const out = {
		transmissionId: get("paypal-transmission-id"),
		transmissionTime: get("paypal-transmission-time"),
		transmissionSig: get("paypal-transmission-sig"),
		certUrl: get("paypal-cert-url"),
		authAlgo: get("paypal-auth-algo"),
	};
	return Object.values(out).every(Boolean) ? out : null;
}

export function isPayPalCertUrl(url: string): boolean {
	try {
		const u = new URL(url);
		return u.protocol === "https:" && CERT_HOSTS.has(u.hostname) && u.pathname.startsWith("/v1/notifications/certs/");
	} catch {
		return false;
	}
}

const certCache = new Map<string, string>();

async function fetchCert(url: string): Promise<string> {
	const hit = certCache.get(url);
	if (hit) return hit;
	const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
	if (!res.ok) throw new Error(`cert fetch ${res.status}`);
	const pem = await res.text();
	certCache.set(url, pem);
	return pem;
}

/** The signed message, exactly as PayPal builds it. Exported for tests. */
export function signedMessage(h: WebhookHeaders, webhookId: string, rawBody: string): string {
	return `${h.transmissionId}|${h.transmissionTime}|${webhookId}|${crc32(Buffer.from(rawBody, "utf8"))}`;
}

export async function verifyWebhookSignature(
	h: WebhookHeaders,
	rawBody: string,
	webhookId: string,
	getCert: (url: string) => Promise<string> = fetchCert,
): Promise<boolean> {
	if (h.authAlgo !== "SHA256withRSA" || !isPayPalCertUrl(h.certUrl)) return false;
	const pem = await getCert(h.certUrl);
	const key = pem.includes("BEGIN CERTIFICATE") ? new X509Certificate(pem).publicKey : createPublicKey(pem);
	return verify(
		"sha256",
		Buffer.from(signedMessage(h, webhookId, rawBody)),
		key,
		Buffer.from(h.transmissionSig, "base64"),
	);
}
