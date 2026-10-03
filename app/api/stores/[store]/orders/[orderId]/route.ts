/** GET /api/stores/{store}/orders/{orderId} — order status and tracking for the agent that placed it */
import { storeRoute } from "@/src/merchant/api/http";
import { orderStatus } from "@/src/merchant/fulfillment";

export const GET = storeRoute<{ store: string; orderId: string }>(async ({ params }) =>
	orderStatus(params.store, params.orderId),
);
