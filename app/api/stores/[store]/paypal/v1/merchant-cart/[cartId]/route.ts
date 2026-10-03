/** GET / PUT /api/stores/{store}/paypal/v1/merchant-cart/{cartId} — Cart API v1 getCart, updateCart */
import { readJson, storeRoute } from "@/src/merchant/api/http";
import { getCart, updateCart } from "@/src/merchant/cart/service";

type P = { store: string; cartId: string };

export const GET = storeRoute<P>(async ({ params }) => getCart(params.store, params.cartId));

export const PUT = storeRoute<P>(async ({ req, params }) =>
	updateCart(params.store, params.cartId, await readJson(req)),
);
