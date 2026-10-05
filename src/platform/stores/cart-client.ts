/**
 * Platform-side client for a merchant's Cart API v1 (and our agentic
 * extensions). It plays the part PayPal's Shopping Cart service plays for
 * Store Sync merchants: signs a short-lived JWT per call and talks plain HTTP,
 * so the merchant contract is exercised exactly as a real caller would.
 *
 * Never throws on 4xx: agents need to read validation issues and errors.
 */

import type { ApiError, CartRequest, CheckoutRequest, PayPalCart } from "@/src/cart-spec/schema";
import { publicUrl } from "@/src/public-url";
import { signCartJwt } from "./jwt-sign";
import { activeSigningKey } from "./keys";

export type StoreRef = { id: string; baseUrl: string; merchantId: string };
export type Reply<T> = { status: number; ok: boolean; body: T | ApiError };

const issuer = () => process.env.JWT_ISSUER || publicUrl();

/** `sid`: an opaque id for the buyer session making the calls (see signCartJwt). */
export function cartClient(store: StoreRef, sid?: string) {
	// `baseUrl` is the store's Cart API root, e.g. https://host/api/stores/{store}/paypal/v1;
	// our agentic extensions (search, offers, orders) live one level up.
	const cartRoot = store.baseUrl.replace(/\/$/, "");
	const storeRoot = cartRoot.replace(/\/paypal\/v1$/, "");

	const call = async <T>(method: string, url: string, body?: unknown, auth = true): Promise<Reply<T>> => {
		const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
		if (auth)
			headers.Authorization = `Bearer ${await signCartJwt(await activeSigningKey(), store.merchantId, issuer(), 600, sid)}`;
		const res = await fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(30_000),
		});
		const text = await res.text();
		let parsed: unknown;
		try {
			parsed = text ? JSON.parse(text) : {};
		} catch {
			parsed = { name: "NON_JSON_RESPONSE", message: text.slice(0, 300) };
		}
		if (res.status >= 500) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 300)}`);
		return { status: res.status, ok: res.ok, body: parsed as T | ApiError };
	};

	return {
		create: (req: CartRequest) => call<PayPalCart>("POST", `${cartRoot}/merchant-cart`, req),
		get: (cartId: string) => call<PayPalCart>("GET", `${cartRoot}/merchant-cart/${cartId}`),
		update: (cartId: string, req: CartRequest) => call<PayPalCart>("PUT", `${cartRoot}/merchant-cart/${cartId}`, req),
		checkout: (cartId: string, req: CheckoutRequest) =>
			call<PayPalCart>("POST", `${cartRoot}/merchant-cart/${cartId}/checkout`, req),
		search: (q: string, maxPriceCents?: number) => {
			const u = new URL(`${storeRoot}/agentic/search`);
			u.searchParams.set("q", q);
			if (maxPriceCents) u.searchParams.set("max_price", (maxPriceCents / 100).toFixed(2));
			return call<SearchResult>("GET", u.toString(), undefined, false);
		},
		offer: (cartId: string, reason?: string) =>
			call<OfferResult>("POST", `${storeRoot}/agentic/offers`, { cart_id: cartId, reason }),
		order: (orderId: string) => call<OrderStatus>("GET", `${storeRoot}/orders/${orderId}`),
	};
}

export type SearchResult = {
	store: { id: string; name: string };
	products: {
		product_id: string;
		title: string;
		description: string | null;
		url: string | null;
		image_url: string | null;
		variants: {
			variant_id: string;
			title: string;
			price: { currency_code: string; value: string };
			availability: string;
			in_stock_quantity: number;
			color: string | null;
			size: string | null;
		}[];
	}[];
};

export type OfferResult =
	| { offer: { code: string; description: string; percent_off: number; expires_at: string }; reason?: undefined }
	| { offer: null; reason: string };

export type OrderStatus = {
	order_id: string;
	status: string;
	total: { currency_code: string; value: string };
	created_at: string;
	shipments: { carrier: string; tracking_number: string; shipped_at: string }[];
};
