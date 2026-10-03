/**
 * Ask PayPal's webhook simulator to send a mock event to our registered webhook.
 * Mock events are signed by PayPal with webhook id "WEBHOOK_ID"; the listener only
 * accepts them when WEBHOOK_ACCEPT_SIMULATOR=true (local testing).
 *
 *   pnpm simulate-webhook [EVENT_TYPE]   (default PAYMENT.CAPTURE.COMPLETED)
 */
import { envCreds, paypal } from "@/src/merchant/paypal/http";

async function main() {
	const event_type = process.argv[2] ?? "PAYMENT.CAPTURE.COMPLETED";
	const webhook_id = process.env.PAYPAL_WEBHOOK_ID;
	if (!webhook_id) throw new Error("PAYPAL_WEBHOOK_ID is not set (run pnpm register-webhook)");
	const { data } = await paypal<{ id: string; event_type: string }>(
		envCreds(),
		"POST",
		"/v1/notifications/simulate-event",
		{
			webhook_id,
			event_type,
			resource_version: event_type.startsWith("CUSTOMER.DISPUTE") ? "1.0" : "2.0",
		},
	);
	console.log(`simulated ${data.event_type} ${data.id}`);
}

main().catch((e) => {
	console.error(e);
	process.exitCode = 1;
});
