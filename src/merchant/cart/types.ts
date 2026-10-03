import type { CheckoutFieldType } from "@/src/cart-spec/schema";

export type Availability = "in_stock" | "out_of_stock" | "backorder" | "preorder";

/** One purchasable variant as the cart engine sees it (product fields denormalised). */
export type CatalogVariant = {
	id: string;
	productId: string;
	groupId: string | null;
	title: string;
	description: string | null;
	url: string | null;
	priceCents: number;
	salePriceCents: number | null;
	currency: string;
	color: string | null;
	size: string | null;
	weightG: number | null;
	availability: Availability;
	stockQty: number;
	/** ISO date the item is expected back / ships (backorder, preorder, out of stock) */
	restockEta: string | null;
	fragile: boolean;
	requiresFields: CheckoutFieldType[];
	/** Feed flag is_eligible_checkout: false means agents may find but not buy it */
	agentCheckout: boolean;
};

export type CouponRow = {
	code: string;
	kind: "percent" | "fixed" | "free_shipping";
	/** percent (0-100) or cents */
	value: number;
	minSubtotalCents: number;
	maxUses: number;
	used: number;
	expiresAt: Date | null;
	/** One-time offers are bound to the cart they were issued for */
	issuedToCartId: string | null;
	description: string | null;
};

/** A purchasable line as sent to PayPal Orders v2. */
export type OrderLine = {
	sku: string;
	name: string;
	quantity: number;
	unitCents: number;
	url?: string;
	description?: string;
};

/** Cart totals in cents; `totalCents` is always the sum of the others. */
export type OrderTotals = {
	itemTotalCents: number;
	shippingCents: number;
	shippingDiscountCents: number;
	taxCents: number;
	discountCents: number;
	totalCents: number;
};

export type ShipTo = {
	fullName?: string;
	addressLine1?: string;
	addressLine2?: string;
	city?: string;
	state?: string;
	postalCode?: string;
	countryCode: string;
};

export { ACCEPT_BACK_ORDER, ACCEPT_PRE_ORDER, type CartPatch } from "@/src/cart-spec/extensions";
