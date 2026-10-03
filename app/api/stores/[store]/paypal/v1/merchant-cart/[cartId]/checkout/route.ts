/** POST /api/stores/{store}/paypal/v1/merchant-cart/{cartId}/checkout — Cart API v1 completeCheckout */
import { readJson, storeRoute } from "@/src/merchant/api/http";
import { checkoutCart } from "@/src/merchant/cart/service";

export const POST = storeRoute<{ store: string; cartId: string }>(async ({ req, params, merchant, caller }) =>
	checkoutCart(merchant, params.cartId, await readJson(req), caller),
);
