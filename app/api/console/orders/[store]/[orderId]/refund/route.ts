/** Console refund: all or part of a captured order, idempotent per request_id. */
import { requireConsoleAction } from "@/src/console/auth";
import { readJson, route } from "@/src/merchant/api/http";
import { refundOrder } from "@/src/merchant/fulfillment";

export const POST = route<{ store: string; orderId: string }>(async ({ req, params }) => {
	await requireConsoleAction(req);
	return refundOrder(params.store, params.orderId, await readJson(req));
});
