import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isPayPalCertUrl, signedMessage, verifyWebhookSignature, type WebhookHeaders } from "./webhook-verify";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = publicKey.export({ type: "spki", format: "pem" }).toString();
const certUrl = "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-360caa42-fca2a594-ab66f33d";
const body = '{"id":"WH-1","event_type":"PAYMENT.CAPTURE.COMPLETED","resource":{"id":"3Y6"}}';

function headers(over: Partial<WebhookHeaders> = {}): WebhookHeaders {
	const h: WebhookHeaders = {
		transmissionId: "db49fb10-1343-11ef-ac58-e32457403f67",
		transmissionTime: "2026-10-05T05:19:23Z",
		transmissionSig: "",
		certUrl,
		authAlgo: "SHA256withRSA",
		...over,
	};
	h.transmissionSig ||= sign("sha256", Buffer.from(signedMessage(h, "WH-ID-123", body)), privateKey).toString("base64");
	return h;
}

const certFrom = async () => pem;

describe("webhook signature", () => {
	it("accepts a correctly signed event", async () => {
		expect(await verifyWebhookSignature(headers(), body, "WH-ID-123", certFrom)).toBe(true);
	});

	it("rejects a tampered body, a different webhook id, and a bad signature", async () => {
		const h = headers();
		expect(await verifyWebhookSignature(h, body.replace("3Y6", "3Y7"), "WH-ID-123", certFrom)).toBe(false);
		expect(await verifyWebhookSignature(h, body, "WH-OTHER", certFrom)).toBe(false);
		expect(
			await verifyWebhookSignature(
				{ ...h, transmissionSig: Buffer.from("x").toString("base64") },
				body,
				"WH-ID-123",
				certFrom,
			),
		).toBe(false);
	});

	it("never fetches a certificate from outside PayPal", async () => {
		let fetched = false;
		const spy = async () => {
			fetched = true;
			return pem;
		};
		const h = headers({ certUrl: "https://evil.example.com/v1/notifications/certs/x" });
		expect(await verifyWebhookSignature(h, body, "WH-ID-123", spy)).toBe(false);
		expect(fetched).toBe(false);
	});

	it("only trusts PayPal certificate URLs over https", () => {
		expect(isPayPalCertUrl(certUrl)).toBe(true);
		expect(isPayPalCertUrl("https://api.paypal.com/v1/notifications/certs/CERT-1")).toBe(true);
		expect(isPayPalCertUrl("http://api.paypal.com/v1/notifications/certs/CERT-1")).toBe(false);
		expect(isPayPalCertUrl("https://api.paypal.com.evil.io/v1/notifications/certs/CERT-1")).toBe(false);
		expect(isPayPalCertUrl("https://api.paypal.com/other")).toBe(false);
	});

	it("rejects an unexpected algorithm", async () => {
		expect(await verifyWebhookSignature(headers({ authAlgo: "SHA1withRSA" }), body, "WH-ID-123", certFrom)).toBe(false);
	});
});
