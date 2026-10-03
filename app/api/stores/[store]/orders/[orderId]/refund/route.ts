/** POST /api/stores/{store}/orders/{orderId}/refund — merchant-only (bearer STORE_ADMIN_TOKEN) */
import { adminRoute, readJson } from "@/src/merchant/api/http";
import { refundOrder } from "@/src/merchant/fulfillment";

export const POST = adminRoute<{ store: string; orderId: string }>(async ({ req, params }) =>
	refundOrder(params.store, params.orderId, await readJson(req)),
);
