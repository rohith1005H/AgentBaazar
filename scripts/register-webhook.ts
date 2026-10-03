/**
 * Subscribe a public HTTPS URL to the PayPal webhook events we handle, for the
 * sandbox app in PAYPAL_CLIENT_ID. Prints the webhook id to put in PAYPAL_WEBHOOK_ID.
 *
 *   pnpm register-webhook --url https://<public host>/api/paypal/webhooks
 *
 * Re-running with the same URL updates its event list instead of creating a duplicate.
 */
import { envCreds, paypal } from "@/src/merchant/paypal/http";

const EVENTS = [
	"CHECKOUT.ORDER.APPROVED",
	"CHECKOUT.ORDER.COMPLETED",
	"PAYMENT.AUTHORIZATION.CREATED",
	"PAYMENT.AUTHORIZATION.VOIDED",
	"PAYMENT.CAPTURE.COMPLETED",
	"PAYMENT.CAPTURE.DENIED",
	"PAYMENT.CAPTURE.DECLINED",
	"PAYMENT.CAPTURE.PENDING",
	"PAYMENT.CAPTURE.REFUNDED",
	"PAYMENT.CAPTURE.REVERSED",
	"CUSTOMER.DISPUTE.CREATED",
	"CUSTOMER.DISPUTE.UPDATED",
	"CUSTOMER.DISPUTE.RESOLVED",
];

type Webhook = { id: string; url: string };

async function main() {
	const i = process.argv.indexOf("--url");
	const url = i > 0 ? process.argv[i + 1] : undefined;
	if (!url?.startsWith("https://"))
		throw new Error("Pass --url https://<public host>/api/paypal/webhooks (PayPal only delivers to HTTPS)");
	const creds = envCreds();
	const { data } = await paypal<{ webhooks: Webhook[] }>(creds, "GET", "/v1/notifications/webhooks");
	const existing = data.webhooks.find((w) => w.url === url);
	const event_types = EVENTS.map((name) => ({ name }));

	if (existing) {
		await paypal(creds, "PATCH", `/v1/notifications/webhooks/${existing.id}`, [
			{ op: "replace", path: "/event_types", value: event_types },
		]);
		console.log(`updated ${existing.id} -> ${url} (${EVENTS.length} events)`);
		console.log(`PAYPAL_WEBHOOK_ID=${existing.id}`);
		return;
	}
	const { data: created } = await paypal<Webhook>(creds, "POST", "/v1/notifications/webhooks", { url, event_types });
	console.log(`created ${created.id} -> ${url} (${EVENTS.length} events)`);
	console.log(`PAYPAL_WEBHOOK_ID=${created.id}`);
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
