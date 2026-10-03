/**
 * Postgres schema (Neon). Two Postgres schemas keep the two parties apart:
 *   merchant.*  — the store adapter (catalog, carts, orders, PayPal state, webhooks)
 *   platform.*  — the buyer agent platform (stores registry, sessions, signing keys)
 */
import { boolean, index, integer, jsonb, pgSchema, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const merchant = pgSchema("merchant");
export const platform = pgSchema("platform");

const ts = (name?: string) => (name ? timestamp(name, { withTimezone: true }) : timestamp({ withTimezone: true }));

// ---------------------------------------------------------------- merchant

export const merchants = merchant.table("merchants", {
	id: text().primaryKey(), // slug, e.g. patel-textiles
	name: text().notNull(),
	paypalMerchantId: text("paypal_merchant_id"),
	paypalClientId: text("paypal_client_id"),
	paypalClientSecretEnc: text("paypal_client_secret_enc"),
	webhookId: text("webhook_id"),
	paymentMode: text("payment_mode").notNull().default("authorize"), // authorize | capture
	policy: jsonb().$type<MerchantPolicy>().notNull(),
	theme: jsonb().$type<Record<string, unknown>>(),
	createdAt: ts("created_at").notNull().defaultNow(),
});

export type ShippingOptionPolicy = {
	id: string;
	name: string;
	baseCents: number;
	perKgCents: number;
	etaDays: number;
	/** ISO-3166-2 state codes served, or ["*"] */
	regions: string[];
};
export type MerchantPolicy = {
	currency: "USD";
	shippingOptions: ShippingOptionPolicy[];
	/** state code -> tax rate, "*" for default */
	taxRates: Record<string, number>;
	/** states we ship to, or ["*"] */
	regionsServed: string[];
	poBoxAllowedForFragile: boolean;
	maintenance?: boolean;
	coupons: {
		firstOrderPct: number;
		bundle?: { minItems: number; pct: number };
		maxTotalPct: number;
		minSubtotalCents: number;
		freeShippingOverCents?: number;
		expiresMinutes: number;
	};
};

export const products = merchant.table(
	"products",
	{
		id: text().primaryKey(),
		merchantId: text("merchant_id")
			.notNull()
			.references(() => merchants.id),
		groupId: text("group_id"),
		title: text().notNull(),
		description: text(),
		brand: text(),
		category: text(),
		url: text(),
		imageUrl: text("image_url"),
		attributes: jsonb().$type<Record<string, unknown>>(),
		flags: jsonb().$type<{
			fragile?: boolean;
			requiresFields?: string[];
			eligibleSearch?: boolean;
			eligibleCheckout?: boolean;
		}>(),
		createdAt: ts("created_at").notNull().defaultNow(),
	},
	(t) => [index("products_merchant_idx").on(t.merchantId)],
);

export const variants = merchant.table(
	"variants",
	{
		id: text().primaryKey(), // feed id / item_id
		productId: text("product_id")
			.notNull()
			.references(() => products.id),
		sku: text(),
		title: text().notNull(),
		url: text(),
		imageUrl: text("image_url"),
		priceCents: integer("price_cents").notNull(),
		salePriceCents: integer("sale_price_cents"),
		currency: text().notNull().default("USD"),
		color: text(),
		size: text(),
		weightG: integer("weight_g"),
		availability: text().notNull().default("in_stock"), // in_stock | out_of_stock | backorder | preorder
		stockQty: integer("stock_qty").notNull().default(0),
		restockEta: text("restock_eta"),
	},
	(t) => [index("variants_product_idx").on(t.productId)],
);

export const coupons = merchant.table("coupons", {
	code: text().primaryKey(),
	merchantId: text("merchant_id")
		.notNull()
		.references(() => merchants.id),
	kind: text().notNull(), // percent | fixed | free_shipping
	value: integer().notNull(), // percent or cents
	minSubtotalCents: integer("min_subtotal_cents").notNull().default(0),
	maxUses: integer("max_uses").notNull().default(1),
	used: integer().notNull().default(0),
	expiresAt: ts("expires_at"),
	issuedToCartId: text("issued_to_cart_id"),
	description: text(),
});

export const carts = merchant.table(
	"carts",
	{
		id: text().primaryKey(), // CART-<ULID>
		merchantId: text("merchant_id")
			.notNull()
			.references(() => merchants.id),
		status: text().notNull(),
		validationStatus: text("validation_status").notNull(),
		/** Optimistic concurrency: every write bumps it, writes check the value they read */
		version: integer().notNull().default(0),
		/** Last cart request accepted (PUT is full replacement), re-evaluated at checkout */
		request: jsonb().$type<Record<string, unknown>>().notNull(),
		/** Last full PayPalCart we returned */
		payload: jsonb().$type<Record<string, unknown>>().notNull(),
		paypalOrderId: text("paypal_order_id"),
		/** Amount of the PayPal order as last created/patched, to know whether it is in sync */
		paypalAmountCents: integer("paypal_amount_cents"),
		approvalUrl: text("approval_url"),
		payerId: text("payer_id"),
		jwtSub: text("jwt_sub"),
		createdAt: ts("created_at").notNull().defaultNow(),
		updatedAt: ts("updated_at").notNull().defaultNow(),
		completedAt: ts("completed_at"),
	},
	(t) => [index("carts_merchant_idx").on(t.merchantId)],
);

export const cartEvents = merchant.table(
	"cart_events",
	{
		id: text().primaryKey(),
		cartId: text("cart_id")
			.notNull()
			.references(() => carts.id),
		kind: text().notNull(), // created | updated | issue | offer | checkout | paypal_error
		data: jsonb().$type<Record<string, unknown>>(),
		at: ts().notNull().defaultNow(),
	},
	(t) => [index("cart_events_cart_idx").on(t.cartId)],
);

export const orders = merchant.table(
	"orders",
	{
		id: text().primaryKey(), // AB-1042
		cartId: text("cart_id").references(() => carts.id),
		merchantId: text("merchant_id")
			.notNull()
			.references(() => merchants.id),
		paypalOrderId: text("paypal_order_id").notNull(),
		authorizationId: text("authorization_id"),
		captureId: text("capture_id"),
		// PENDING (stock reserved, payment in flight) | AUTHORIZED | CAPTURED | VOIDED | REFUNDED
		// | PARTIALLY_REFUNDED | DISPUTED | FAILED
		status: text().notNull(),
		totalCents: integer("total_cents").notNull(),
		totals: jsonb().$type<Record<string, unknown>>().notNull(),
		buyer: jsonb().$type<Record<string, unknown>>(),
		shipTo: jsonb("ship_to").$type<Record<string, unknown>>(),
		source: text().notNull().default("agent"), // agent | storefront
		agentPlatform: text("agent_platform"),
		createdAt: ts("created_at").notNull().defaultNow(),
		capturedAt: ts("captured_at"),
	},
	(t) => [index("orders_merchant_idx").on(t.merchantId), uniqueIndex("orders_paypal_order_idx").on(t.paypalOrderId)],
);

/** Human-friendly merchant order numbers: AB-1001, AB-1002, ... */
export const orderNumberSeq = merchant.sequence("order_number_seq", { startWith: 1001 });

export const orderItems = merchant.table("order_items", {
	id: text().primaryKey(),
	orderId: text("order_id")
		.notNull()
		.references(() => orders.id),
	variantId: text("variant_id").notNull(),
	qty: integer().notNull(),
	unitCents: integer("unit_cents").notNull(),
	title: text().notNull(),
	/** True when checkout drew this line from on-hand stock (not a back-/pre-order), so a void puts it back */
	stockReserved: boolean("stock_reserved").notNull().default(true),
});

export const shipments = merchant.table("shipments", {
	id: text().primaryKey(),
	orderId: text("order_id")
		.notNull()
		.references(() => orders.id),
	carrier: text().notNull(),
	trackingNumber: text("tracking_number").notNull(),
	paypalTrackerId: text("paypal_tracker_id"),
	status: text().notNull().default("SHIPPED"),
	shippedAt: ts("shipped_at").notNull().defaultNow(),
});

export const refunds = merchant.table("refunds", {
	id: text().primaryKey(),
	orderId: text("order_id")
		.notNull()
		.references(() => orders.id),
	captureId: text("capture_id").notNull(),
	paypalRefundId: text("paypal_refund_id").notNull(),
	amountCents: integer("amount_cents").notNull(),
	reason: text(),
	at: ts().notNull().defaultNow(),
});

export const disputes = merchant.table("disputes", {
	id: text().primaryKey(), // PayPal dispute id
	orderId: text("order_id").references(() => orders.id),
	merchantId: text("merchant_id")
		.notNull()
		.references(() => merchants.id),
	reason: text(),
	status: text(),
	stage: text(),
	amountCents: integer("amount_cents"),
	respondBy: ts("respond_by"),
	raw: jsonb().$type<Record<string, unknown>>(),
	updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const webhookEvents = merchant.table(
	"webhook_events",
	{
		id: text().primaryKey(), // PayPal event id => natural dedupe
		merchantId: text("merchant_id").references(() => merchants.id),
		eventType: text("event_type").notNull(),
		resourceType: text("resource_type"),
		resourceId: text("resource_id"),
		verified: boolean().notNull().default(false),
		raw: jsonb().$type<Record<string, unknown>>().notNull(),
		receivedAt: ts("received_at").notNull().defaultNow(),
		processedAt: ts("processed_at"),
	},
	(t) => [index("webhook_events_type_idx").on(t.eventType)],
);

// ---------------------------------------------------------------- platform

export const stores = platform.table("stores", {
	id: text().primaryKey(),
	name: text().notNull(),
	baseUrl: text("base_url").notNull(),
	merchantId: text("merchant_id").notNull(), // JWT audience
	enabled: boolean().notNull().default(true),
});

export const sessions = platform.table("sessions", {
	id: text().primaryKey(),
	mandate: jsonb().$type<Record<string, unknown>>(),
	createdAt: ts("created_at").notNull().defaultNow(),
});

export const messages = platform.table(
	"messages",
	{
		id: text().primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id),
		role: text().notNull(),
		parts: jsonb().$type<unknown[]>().notNull(),
		at: ts().notNull().defaultNow(),
	},
	(t) => [index("messages_session_idx").on(t.sessionId)],
);

export const sessionCarts = platform.table("session_carts", {
	cartId: text("cart_id").primaryKey(),
	sessionId: text("session_id")
		.notNull()
		.references(() => sessions.id),
	storeId: text("store_id")
		.notNull()
		.references(() => stores.id),
	paypalOrderId: text("paypal_order_id"),
	status: text().notNull().default("open"), // open | approved | completed | cancelled
	approvedPayerId: text("approved_payer_id"),
	lastCart: jsonb("last_cart").$type<Record<string, unknown>>(),
	updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const signingKeys = platform.table("signing_keys", {
	kid: text().primaryKey(),
	privateJwkEnc: text("private_jwk_enc").notNull(),
	publicJwk: jsonb("public_jwk").$type<Record<string, unknown>>().notNull(),
	active: boolean().notNull().default(true),
	createdAt: ts("created_at").notNull().defaultNow(),
});
