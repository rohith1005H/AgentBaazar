/**
 * Turning a merchant's cart response into the next PUT.
 *
 * PUT /merchant-cart/{id} is a full replacement, so the platform always sends
 * the whole cart: `requestFromCart` strips server-calculated fields from the
 * last response, and `applyPatch` applies a resolution option's
 * `metadata.apply` patch to it. Pure functions, no I/O.
 */
import type { CartPatch } from "@/src/cart-spec/extensions";
import type { CartItem, CartRequest, CheckoutField, PayPalCart } from "@/src/cart-spec/schema";

/** The writable part of a returned cart, ready to PUT back unchanged. */
export function requestFromCart(cart: PayPalCart): CartRequest {
	const selected = cart.available_shipping_options?.find((o) => o.is_selected);
	const fields = (cart.checkout_fields ?? []).filter((f) => f.value !== undefined && f.status !== "REJECTED");
	return {
		items: (cart.items ?? []).map(writableItem),
		...(cart.customer && { customer: cart.customer }),
		...(cart.shipping_address && { shipping_address: cart.shipping_address }),
		...(cart.billing_address && { billing_address: cart.billing_address }),
		...(cart.geo_coordinates && { geo_coordinates: cart.geo_coordinates }),
		...(selected && { available_shipping_options: [selected] }),
		...(fields.length > 0 && {
			checkout_fields: fields.map(({ type, value }) => ({ type, status: "COMPLETED" as const, value })),
		}),
		...((cart.applied_coupons?.length ?? 0) > 0 && {
			coupons: cart.applied_coupons!.map((c) => ({ code: c.code, action: "APPLY" as const })),
		}),
	};
}

function writableItem(i: CartItem): CartItem {
	return {
		...(i.variant_id && { variant_id: i.variant_id }),
		...(!i.variant_id && i.item_id && { item_id: i.item_id }),
		quantity: i.quantity,
		// Quoting the price we were shown lets the merchant flag a price change.
		...(i.price && { price: i.price }),
		...(i.gift_options && { gift_options: i.gift_options }),
		...(i.custom_options && { custom_options: i.custom_options }),
	};
}

/**
 * Apply one patch. `value` is required for set_checkout_field (the buyer's answer);
 * every other op is fully described by the patch itself.
 */
export function applyPatch(req: CartRequest, patch: CartPatch, value?: unknown): CartRequest {
	const items = req.items;
	const mapItem = (id: string, fn: (i: CartItem) => CartItem | null): CartItem[] =>
		items.flatMap((i) => {
			if (i.variant_id !== id) return [i];
			const next = fn(i);
			return next ? [next] : [];
		});

	switch (patch.op) {
		case "replace_variant": {
			const from = items.find((i) => i.variant_id === patch.variant_id);
			const rest = items.filter((i) => i.variant_id !== patch.variant_id);
			if (!from) return req;
			// a different variant has its own price; do not carry the old quote over
			const { price: _ignored, ...kept } = from;
			const existing = rest.find((i) => i.variant_id === patch.with_variant_id);
			const merged = existing
				? rest.map((i) => (i === existing ? { ...i, quantity: i.quantity + from.quantity } : i))
				: [...rest, { ...kept, variant_id: patch.with_variant_id }];
			return { ...req, items: merged };
		}
		case "set_quantity":
			return { ...req, items: mapItem(patch.variant_id, (i) => ({ ...i, quantity: patch.quantity })) };
		case "remove_item":
			return { ...req, items: mapItem(patch.variant_id, () => null) };
		case "add_custom_option":
			return {
				...req,
				items: mapItem(patch.variant_id, (i) => ({
					...i,
					custom_options: [...(i.custom_options ?? []).filter((o) => o.name !== patch.option.name), patch.option],
				})),
			};
		case "set_price":
			return { ...req, items: mapItem(patch.variant_id, (i) => ({ ...i, price: patch.price })) };
		case "remove_coupon":
			return { ...req, coupons: (req.coupons ?? []).filter((c) => c.code.toUpperCase() !== patch.code.toUpperCase()) };
		case "set_checkout_field": {
			if (value === undefined) throw new Error(`set_checkout_field ${patch.type} needs a value`);
			const field: CheckoutField = { type: patch.type, status: "COMPLETED", value };
			return { ...req, checkout_fields: [...(req.checkout_fields ?? []).filter((f) => f.type !== patch.type), field] };
		}
	}
}

/** Add a coupon code (e.g. one returned by the offers endpoint). */
export function applyCoupon(req: CartRequest, code: string): CartRequest {
	const coupons = (req.coupons ?? []).filter((c) => c.code.toUpperCase() !== code.toUpperCase());
	return { ...req, coupons: [...coupons, { code, action: "APPLY" }] };
}
