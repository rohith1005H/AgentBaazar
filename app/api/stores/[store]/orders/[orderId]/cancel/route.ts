/** POST /api/stores/{store}/orders/{orderId}/cancel — merchant-only (bearer STORE_ADMIN_TOKEN) */
import { adminRoute } from "@/src/merchant/api/http";
import { cancelOrder } from "@/src/merchant/fulfillment";

export const POST = adminRoute<{ store: string; orderId: string }>(async ({ params }) =>
	cancelOrder(params.store, params.orderId),
);
