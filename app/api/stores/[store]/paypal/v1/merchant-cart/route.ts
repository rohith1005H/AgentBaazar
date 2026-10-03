/** POST /api/stores/{store}/paypal/v1/merchant-cart — Cart API v1 createCart */
import { readJson, storeRoute } from "@/src/merchant/api/http";
import { createCart } from "@/src/merchant/cart/service";

export const POST = storeRoute<{ store: string }>(async ({ req, merchant, caller }) =>
	createCart(merchant, await readJson(req), caller),
);
