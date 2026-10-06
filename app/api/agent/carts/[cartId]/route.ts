/**
 * What the chat's "Approve in PayPal" card polls: the store's view of this session's cart,
 * its PayPal approval link, and whether the buyer has approved yet. Only carts this session
 * opened are visible; nothing here can move money.
 */

import type { PayPalCart } from "@/src/cart-spec/schema";
import { route } from "@/src/merchant/api/http";
import { currentSession, saveSessionCart, sessionCart, sessionTag, storeRef } from "@/src/platform/agent/session";
import { cartView } from "@/src/platform/agent/tools";
import { cartClient } from "@/src/platform/stores/cart-client";

export const GET = route<{ cartId: string }>(async ({ params }) => {
	const session = await currentSession({ create: false });
	const sc = await sessionCart(session.id, params.cartId).catch(() => null);
	if (!sc) return { status: 404, body: { name: "CART_NOT_FOUND", message: "No such cart in this session" } };
	const r = await cartClient(await storeRef(sc.storeId), sessionTag(session)).get(params.cartId);
	if (!r.ok) return { status: r.status, body: r.body };
	const cart = r.body as PayPalCart;
	await saveSessionCart(session.id, sc.storeId, cart);
	const view = cartView(sc.storeId, cart);
	const max = session.mandate?.max_total_cents;
	return {
		status: 200,
		body: {
			cart: view,
			approval_url: cart.payment_method?.approval_url ?? null,
			approved: Boolean(cart.payment_method?.payer_id),
			within_budget: max === undefined || view.total_cents === undefined ? null : view.total_cents <= max,
		},
	};
});
