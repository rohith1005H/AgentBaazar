/** Console cancel: voids the PayPal authorization of an order that has not shipped. */
import { requireConsole } from "@/src/console/auth";
import { route } from "@/src/merchant/api/http";
import { cancelOrder } from "@/src/merchant/fulfillment";

export const POST = route<{ store: string; orderId: string }>(async ({ params }) => {
	await requireConsole();
	return cancelOrder(params.store, params.orderId);
});
