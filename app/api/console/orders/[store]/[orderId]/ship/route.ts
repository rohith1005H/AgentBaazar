/**
 * The console's Ship button: captures the PayPal authorization and posts tracking.
 * Demo shipments go out as UPS with a generated tracking number.
 */
import { requireConsoleAction } from "@/src/console/auth";
import { readJson, route } from "@/src/merchant/api/http";
import { shipOrder } from "@/src/merchant/fulfillment";

export const POST = route<{ store: string; orderId: string }>(async ({ req, params }) => {
	await requireConsoleAction(req);
	const body = (await readJson(req).catch(() => ({}))) as { carrier?: string; tracking_number?: string };
	return shipOrder(params.store, params.orderId, {
		carrier: body.carrier ?? "UPS",
		tracking_number: body.tracking_number ?? `1Z999AA1${Date.now().toString().slice(-8)}`,
	});
});
