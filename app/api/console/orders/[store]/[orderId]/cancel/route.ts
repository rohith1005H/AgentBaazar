/** Console cancel: voids the PayPal authorization of an order that has not shipped. */
import { requireConsoleAction } from "@/src/console/auth";
import { route } from "@/src/merchant/api/http";
import { cancelOrder } from "@/src/merchant/fulfillment";

export const POST = route<{ store: string; orderId: string }>(async ({ req, params }) => {
	await requireConsoleAction(req);
	return cancelOrder(params.store, params.orderId);
});
