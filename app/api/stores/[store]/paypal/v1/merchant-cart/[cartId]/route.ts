/** GET / PUT /api/stores/{store}/paypal/v1/merchant-cart/{cartId} — Cart API v1 getCart, updateCart */
import { readJson, storeRoute } from "@/src/merchant/api/http";
import { getCart, updateCart } from "@/src/merchant/cart/service";

type P = { store: string; cartId: string };

export const GET = storeRoute<P>(async ({ params, merchant, caller }) => getCart(merchant, params.cartId, caller));

export const PUT = storeRoute<P>(async ({ req, params, merchant, caller }) =>
	updateCart(merchant, params.cartId, await readJson(req), caller),
);
