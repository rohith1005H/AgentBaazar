/**
 * PayPal Cart API v1 — zod schemas hand-written from the public OpenAPI spec
 * (developer.paypal.com/api/agentic-commerce/v1/schema.yaml, Apache-2.0).
 *
 * These are the exact objects PayPal's Shopping Cart service exchanges with a
 * Store Sync merchant. We validate every request we accept and every response
 * we return against them so the merchant side stays spec-conformant.
 *
 * Shared by the merchant side (server) and the platform side (client).
 */
import { z } from "zod";

// ---- primitives ----------------------------------------------------------

export const Money = z.object({
	currency_code: z.string().length(3),
	/** Decimal string, e.g. "25.00". Two decimals for USD. */
	value: z.string().regex(/^\d+(\.\d{1,2})?$/),
});
export type Money = z.infer<typeof Money>;

export const Address = z.object({
	address_line_1: z.string().optional(),
	address_line_2: z.string().optional(),
	/** City */
	admin_area_2: z.string().optional(),
	/** State / province */
	admin_area_1: z.string().optional(),
	postal_code: z.string().optional(),
	country_code: z.string().length(2),
});
export type Address = z.infer<typeof Address>;

export const Customer = z.object({
	name: z.object({ given_name: z.string().optional(), surname: z.string().optional() }).optional(),
	phone: z
		.object({ phone_number: z.object({ national_number: z.string() }).optional() })
		.passthrough()
		.optional(),
	email_address: z.string().email().optional(),
});
export type Customer = z.infer<typeof Customer>;

export const GeoCoordinates = z.object({
	latitude: z.string(),
	longitude: z.string(),
	subdivision: z.string().optional(),
	country_code: z.string().length(2).optional(),
});

// ---- enums ---------------------------------------------------------------

export const CartStatus = z.enum(["CREATED", "INCOMPLETE", "READY", "COMPLETED"]);
export type CartStatus = z.infer<typeof CartStatus>;

export const ValidationStatus = z.enum(["VALID", "INVALID", "REQUIRES_ADDITIONAL_INFORMATION"]);
export type ValidationStatus = z.infer<typeof ValidationStatus>;

export const IssueCode = z.enum([
	"INVENTORY_ISSUE",
	"PRICING_ERROR",
	"SHIPPING_ERROR",
	"PAYMENT_ERROR",
	"DATA_ERROR",
	"BUSINESS_RULE_ERROR",
]);
export type IssueCode = z.infer<typeof IssueCode>;

export const IssueType = z.enum(["MISSING_FIELD", "INVALID_DATA", "BUSINESS_RULE"]);
export type IssueType = z.infer<typeof IssueType>;

export const ResolutionAction = z.enum([
	"REDIRECT_TO_MERCHANT",
	"MODIFY_CART",
	"ACCEPT_NEW_PRICE",
	"ACCEPT_BACK_ORDER",
	"SUGGEST_ALTERNATIVE",
	"REMOVE_ITEM",
	"UPDATE_ADDRESS",
	"PROVIDE_MISSING_FIELD",
	"USE_DIFFERENT_PAYMENT",
	"SPLIT_ORDER",
	"CONTACT_SUPPORT",
	"RETRY_LATER",
	"REQUEST_APPROVAL",
	"WAIT_FOR_RESTOCK",
	"USE_DIFFERENT_CURRENCY",
	"ACCEPT_PRE_ORDER",
	"UPDATE_SHIPPING_METHOD",
	"ACCEPT_TERMS",
	"VERIFY_ACCOUNT",
	"APPLY_DIFFERENT_COUPON",
	"REMOVE_COUPON",
	"CHOOSE_DIFFERENT_VARIANT",
]);
export type ResolutionAction = z.infer<typeof ResolutionAction>;

export const CheckoutFieldType = z.enum([
	"AGE_VERIFICATION_18_PLUS",
	"AGE_VERIFICATION_21_PLUS",
	"GIFT_RECIPIENT_EMAIL",
	"GIFT_RECIPIENT_NAME",
	"GIFT_MESSAGE",
	"DELIVERY_INSTRUCTIONS",
	"DELIVERY_DATE_PREFERENCE",
	"ALLERGY_INFORMATION",
	"CUSTOM_ENGRAVING_TEXT",
	"CUSTOM_SIZING_INFO",
	"TERMS_ACCEPTANCE",
	"PRIVACY_CONSENT",
]);
export type CheckoutFieldType = z.infer<typeof CheckoutFieldType>;

export const CheckoutFieldStatus = z.enum(["PENDING", "COMPLETED", "REJECTED", "ERROR"]);

// ---- issues --------------------------------------------------------------

export const ResolutionOption = z.object({
	action: ResolutionAction,
	label: z.string(),
	url: z.string().url().optional(),
	/** e.g. { auto_applicable: true, priority: "high", alternatives: [...] } */
	metadata: z.record(z.string(), z.unknown()).optional(),
});
export type ResolutionOption = z.infer<typeof ResolutionOption>;

export const ValidationIssue = z.object({
	code: IssueCode,
	type: IssueType,
	/** Technical message for developers and logs */
	message: z.string(),
	/** Customer-friendly message the agent can show */
	user_message: z.string().optional(),
	variant_id: z.string().optional(),
	field: z.string().optional(),
	/** Category-specific context, e.g. { specific_issue: "ITEM_OUT_OF_STOCK", available_quantity: 0 } */
	context: z.record(z.string(), z.unknown()).optional(),
	resolution_options: z.array(ResolutionOption).optional(),
});
export type ValidationIssue = z.infer<typeof ValidationIssue>;

// ---- cart parts ----------------------------------------------------------

export const GiftOptions = z.object({
	is_gift: z.boolean().optional(),
	recipient: z.object({ name: z.string().optional(), email: z.string().email().optional() }).optional(),
	/** RFC3339 */
	delivery_date: z.string().optional(),
	sender_name: z.string().optional(),
	gift_message: z.string().max(500).optional(),
	gift_wrap: z.boolean().optional(),
});

export const CartItem = z.object({
	/** Deprecated in v1; accepted for backwards compatibility */
	item_id: z.string().optional(),
	variant_id: z.string().optional(),
	parent_id: z.string().optional(),
	quantity: z.number().int().positive(),
	name: z.string().optional(),
	description: z.string().optional(),
	item_url: z.string().url().optional(),
	price: Money.optional(),
	selected_attributes: z.array(z.record(z.string(), z.unknown())).optional(),
	gift_options: GiftOptions.optional(),
	custom_options: z.array(z.record(z.string(), z.unknown())).optional(),
});
export type CartItem = z.infer<typeof CartItem>;

export const PaymentMethod = z.object({
	type: z.literal("paypal"),
	/** PayPal order id (we issue it at cart create) */
	token: z.string().optional(),
	/** Present after the buyer approved */
	payer_id: z.string().optional(),
	approval_url: z.string().url().optional(),
});
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const CartTotals = z.object({
	subtotal: Money.optional(),
	discount: Money.optional(),
	shipping: Money.optional(),
	tax: Money.optional(),
	handling: Money.optional(),
	insurance: Money.optional(),
	shipping_discount: Money.optional(),
	custom_charges: Money.optional(),
	total: Money,
});
export type CartTotals = z.infer<typeof CartTotals>;

export const ShippingOption = z.object({
	id: z.string(),
	name: z.string(),
	description: z.string().optional(),
	price: Money,
	is_selected: z.boolean(),
	/** YYYY-MM-DD */
	estimated_delivery: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional(),
});
export type ShippingOption = z.infer<typeof ShippingOption>;

export const Coupon = z.object({
	code: z.string(),
	action: z.enum(["APPLY", "REMOVE"]),
});
export type Coupon = z.infer<typeof Coupon>;

export const AppliedCoupon = z.object({
	code: z.string(),
	description: z.string().optional(),
	discount_amount: Money.optional(),
});

export const CheckoutField = z.object({
	type: CheckoutFieldType,
	status: CheckoutFieldStatus,
	/** Type-specific value; we keep it loose and validate per type in the engine */
	value: z.unknown().optional(),
	context: z.record(z.string(), z.unknown()).optional(),
	validation_issue: ValidationIssue.optional(),
});
export type CheckoutField = z.infer<typeof CheckoutField>;

export const PaymentConfirmation = z.object({
	merchant_order_number: z.string(),
	order_review_page: z.string().url().optional(),
});

// ---- the cart ------------------------------------------------------------

/** Full PayPalCart as returned by the merchant. */
export const PayPalCart = z.object({
	id: z.string().optional(),
	status: CartStatus.optional(),
	validation_status: ValidationStatus.optional(),
	validation_issues: z.array(ValidationIssue).optional(),
	totals: CartTotals.optional(),
	applied_coupons: z.array(AppliedCoupon).optional(),
	available_shipping_options: z.array(ShippingOption).optional(),
	items: z.array(CartItem).optional(),
	customer: Customer.optional(),
	shipping_address: Address.optional(),
	billing_address: Address.optional(),
	payment_method: PaymentMethod.optional(),
	checkout_fields: z.array(CheckoutField).optional(),
	coupons: z.array(Coupon).optional(),
	geo_coordinates: GeoCoordinates.optional(),
	/** Present on the completed-checkout response (Store Sync integration guide) */
	payment_confirmation: PaymentConfirmation.optional(),
});
export type PayPalCart = z.infer<typeof PayPalCart>;

/** What a caller sends to POST /merchant-cart and PUT /merchant-cart/{id}. */
export const CartRequest = PayPalCart.pick({
	items: true,
	customer: true,
	shipping_address: true,
	billing_address: true,
	payment_method: true,
	checkout_fields: true,
	coupons: true,
	geo_coordinates: true,
	available_shipping_options: true,
}).extend({
	items: z.array(CartItem).min(1),
});
export type CartRequest = z.infer<typeof CartRequest>;

/** What a caller sends to POST /merchant-cart/{id}/checkout. */
export const CheckoutRequest = z.object({
	payment_method: PaymentMethod,
});
export type CheckoutRequest = z.infer<typeof CheckoutRequest>;

/** Error envelope for 4xx/5xx, same shape PayPal uses. */
export const ApiError = z.object({
	name: z.string(),
	message: z.string(),
	debug_id: z.string().optional(),
	details: z
		.array(z.object({ field: z.string().optional(), issue: z.string().optional(), description: z.string().optional() }))
		.optional(),
});
export type ApiError = z.infer<typeof ApiError>;

export const CART_ID_PATTERN = /^CART-[A-Z0-9]+$/;
