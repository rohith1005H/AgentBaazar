/** POST /api/stores/{store}/orders/{orderId}/ship — merchant-only (bearer STORE_ADMIN_TOKEN) */
import { adminRoute, readJson } from "@/src/merchant/api/http";
import { shipOrder } from "@/src/merchant/fulfillment";

export const POST = adminRoute<{ store: string; orderId: string }>(async ({ req, params }) =>
	shipOrder(params.store, params.orderId, await readJson(req)),
);
