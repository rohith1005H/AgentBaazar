/**
 * Orders v2 + Payments v2 through PayPal's official server SDK.
 *
 * Why the SDK here and raw fetch in http.ts: the SDK types Orders/Payments and
 * supports `paypalRequestId` natively; it does not cover webhooks or OAuth for
 * the MCP token, so those stay in http.ts. One error shape (PayPalError) for both.
 *
 * Money is handled in integer cents everywhere and rendered as "12.34" only at
 * the PayPal boundary, so breakdowns always sum exactly (AMOUNT_MISMATCH-proof).
 */
import {
	ApiError,
	CheckoutPaymentIntent,
	Client,
	Environment,
	ItemCategory,
	type Order,
	type OrderRequest,
	OrdersController,
	type Patch,
	PatchOp,
	PaymentsController,
	PaypalExperienceUserAction,
	PaypalWalletContextShippingPreference,
	ShipmentCarrier,
} from "@paypal/paypal-server-sdk";
import { toCents } from "@/src/merchant/cart/money";
import type { OrderLine, OrderTotals, ShipTo } from "@/src/merchant/cart/types";
import { type PayPalCreds, PayPalError } from "./http";

// ---- client cache -------------------------------------------------------

const clients = new Map<string, { orders: OrdersController; payments: PaymentsController }>();

function sdk(creds: PayPalCreds) {
	let c = clients.get(creds.clientId);
	if (!c) {
		const client = new Client({
			clientCredentialsAuthCredentials: { oAuthClientId: creds.clientId, oAuthClientSecret: creds.clientSecret },
			environment: process.env.PAYPAL_ENV === "live" ? Environment.Production : Environment.Sandbox,
			timeout: 30_000,
			// Retry throttling and transient server errors. Safe for POSTs because every
			// money-moving call carries a PayPal-Request-Id, so a retry returns the original result.
			httpClientOptions: {
				retryConfig: {
					maxNumberOfRetries: 3,
					retryOnTimeout: false,
					retryInterval: 1,
					maximumRetryWaitTime: 15,
					backoffFactor: 2,
					httpStatusCodesToRetry: [429, 500, 502, 503, 504],
					httpMethodsToRetry: ["GET", "POST", "PATCH"],
				},
			},
		});
		c = { orders: new OrdersController(client), payments: new PaymentsController(client) };
		clients.set(creds.clientId, c);
	}
	return c;
}

/** Normalise SDK ApiError into our PayPalError so callers see one shape. */
async function run<T>(fn: () => Promise<{ result: T; statusCode: number }>): Promise<T> {
	try {
		return (await fn()).result;
	} catch (e) {
		if (e instanceof ApiError) {
			const b = (e.result ?? {}) as { name?: string; message?: string; debug_id?: string; details?: unknown };
			throw new PayPalError(e.statusCode, b.name ?? "PAYPAL_ERROR", b.message ?? e.message, b.debug_id, b.details);
		}
		throw e;
	}
}

// ---- money helpers ------------------------------------------------------

export type { OrderLine, OrderTotals, ShipTo };

/** "12.34" -> 1234; missing -> -1 so it can never match an expected amount. */
const cents = (v: string | undefined) => (v ? toCents(v) : -1);

/** SDK (camelCase) money. */
export const money = (cents: number, currencyCode = "USD") => ({ currencyCode, value: (cents / 100).toFixed(2) });
/** Wire (snake_case) money, for PATCH values the SDK passes through untouched. */
const wireMoney = (cents: number, currency_code = "USD") => ({ currency_code, value: (cents / 100).toFixed(2) });

export function assertTotals(t: OrderTotals): void {
	const sum = t.itemTotalCents + t.shippingCents - t.shippingDiscountCents + t.taxCents - t.discountCents;
	if (sum !== t.totalCents) throw new Error(`Totals do not add up: ${sum} != ${t.totalCents}`);
}

function amountWithBreakdown(t: OrderTotals) {
	assertTotals(t);
	return {
		...money(t.totalCents),
		breakdown: {
			itemTotal: money(t.itemTotalCents),
			shipping: money(t.shippingCents),
			shippingDiscount: money(t.shippingDiscountCents),
			taxTotal: money(t.taxCents),
			discount: money(t.discountCents),
		},
	};
}

function wireAmount(t: OrderTotals) {
	assertTotals(t);
	return {
		...wireMoney(t.totalCents),
		breakdown: {
			item_total: wireMoney(t.itemTotalCents),
			shipping: wireMoney(t.shippingCents),
			shipping_discount: wireMoney(t.shippingDiscountCents),
			tax_total: wireMoney(t.taxCents),
			discount: wireMoney(t.discountCents),
		},
	};
}

function items(lines: OrderLine[]) {
	return lines.map((l) => ({
		name: l.name.slice(0, 127),
		sku: l.sku.slice(0, 127),
		description: l.description?.slice(0, 127),
		quantity: String(l.quantity),
		unitAmount: money(l.unitCents),
		category: ItemCategory.PhysicalGoods,
		url: l.url,
	}));
}

function wireItems(lines: OrderLine[]) {
	return lines.map((l) => ({
		name: l.name.slice(0, 127),
		sku: l.sku.slice(0, 127),
		...(l.description && { description: l.description.slice(0, 127) }),
		quantity: String(l.quantity),
		unit_amount: wireMoney(l.unitCents),
		category: "PHYSICAL_GOODS",
		...(l.url && { url: l.url }),
	}));
}

function shipping(s?: ShipTo) {
	if (!s) return undefined;
	return {
		name: s.fullName ? { fullName: s.fullName } : undefined,
		address: {
			addressLine1: s.addressLine1,
			addressLine2: s.addressLine2,
			adminArea2: s.city,
			adminArea1: s.state,
			postalCode: s.postalCode,
			countryCode: s.countryCode,
		},
	};
}

const wireAddress = (s: ShipTo) => ({
	...(s.addressLine1 && { address_line_1: s.addressLine1 }),
	...(s.addressLine2 && { address_line_2: s.addressLine2 }),
	...(s.city && { admin_area_2: s.city }),
	...(s.state && { admin_area_1: s.state }),
	...(s.postalCode && { postal_code: s.postalCode }),
	country_code: s.countryCode,
});

// ---- orders -------------------------------------------------------------

export type CreateOrderInput = {
	mode: "authorize" | "capture";
	/** Idempotency key; persist it with the cart */
	requestId: string;
	/** Merchant order number candidate; PayPal enforces uniqueness per merchant */
	invoiceId: string;
	/** Our cart id, echoed back in webhooks */
	customId: string;
	lines: OrderLine[];
	totals: OrderTotals;
	shipTo?: ShipTo;
	returnUrl: string;
	cancelUrl: string;
	brandName?: string;
};

export type CreatedOrder = { id: string; status: string; approvalUrl?: string };

export async function createOrder(creds: PayPalCreds, input: CreateOrderInput): Promise<CreatedOrder> {
	const body: OrderRequest = {
		intent: input.mode === "authorize" ? CheckoutPaymentIntent.Authorize : CheckoutPaymentIntent.Capture,
		purchaseUnits: [
			{
				referenceId: "default",
				invoiceId: input.invoiceId,
				customId: input.customId,
				amount: amountWithBreakdown(input.totals),
				items: items(input.lines),
				shipping: shipping(input.shipTo),
			},
		],
		paymentSource: {
			paypal: {
				experienceContext: {
					brandName: input.brandName ?? "AgentBaazar",
					userAction: PaypalExperienceUserAction.PayNow,
					shippingPreference: input.shipTo
						? PaypalWalletContextShippingPreference.SetProvidedAddress
						: PaypalWalletContextShippingPreference.GetFromFile,
					returnUrl: input.returnUrl,
					cancelUrl: input.cancelUrl,
				},
			},
		},
	};
	const order = await run(() =>
		sdk(creds).orders.createOrder({ body, paypalRequestId: input.requestId, prefer: "return=representation" }),
	);
	return { id: order.id!, status: order.status ?? "CREATED", approvalUrl: approvalLink(order) };
}

export function approvalLink(order: Order): string | undefined {
	return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}

export async function getOrder(creds: PayPalCreds, id: string): Promise<Order> {
	return run(() => sdk(creds).orders.getOrder({ id }));
}

/**
 * Replace amount, items and shipping address on a CREATED/APPROVED order after
 * the cart changed. Patch values are sent verbatim by the SDK, so they use the
 * wire (snake_case) shapes.
 */
export async function patchOrder(
	creds: PayPalCreds,
	id: string,
	patch: { totals: OrderTotals; lines?: OrderLine[]; shipTo?: ShipTo },
): Promise<void> {
	const unit = "/purchase_units/@reference_id=='default'";
	const ops: Patch[] = [{ op: PatchOp.Replace, path: `${unit}/amount`, value: wireAmount(patch.totals) }];
	if (patch.lines) ops.push({ op: PatchOp.Replace, path: `${unit}/items`, value: wireItems(patch.lines) });
	if (patch.shipTo)
		ops.push({ op: PatchOp.Replace, path: `${unit}/shipping/address`, value: wireAddress(patch.shipTo) });
	await run(() => sdk(creds).orders.patchOrder({ id, body: ops }));
}

/** `status` and `amountCents` are PayPal's answer; the caller must check both. */
export type AuthorizeResult = { authorizationId: string; status: string; amountCents: number };

/** After buyer approval, in authorize mode. */
export async function authorizeOrder(creds: PayPalCreds, id: string, requestId: string): Promise<AuthorizeResult> {
	const res = await run(() =>
		sdk(creds).orders.authorizeOrder({ id, paypalRequestId: requestId, prefer: "return=representation" }),
	);
	const auth = res.purchaseUnits?.[0]?.payments?.authorizations?.[0];
	if (!auth?.id) throw new PayPalError(502, "NO_AUTHORIZATION", "PayPal returned no authorization", undefined, res);
	return { authorizationId: auth.id, status: auth.status ?? "UNKNOWN", amountCents: cents(auth.amount?.value) };
}

export type CaptureResult = { captureId: string; status: string; amountCents: number };

/** After buyer approval, in capture mode (also used by the storefront button). */
export async function captureOrder(creds: PayPalCreds, id: string, requestId: string): Promise<CaptureResult> {
	const res = await run(() =>
		sdk(creds).orders.captureOrder({ id, paypalRequestId: requestId, prefer: "return=representation" }),
	);
	const cap = res.purchaseUnits?.[0]?.payments?.captures?.[0];
	if (!cap?.id) throw new PayPalError(502, "NO_CAPTURE", "PayPal returned no capture", undefined, res);
	return { captureId: cap.id, status: cap.status ?? "UNKNOWN", amountCents: cents(cap.amount?.value) };
}

// ---- payments (authorizations / captures) --------------------------------

/** Capture on ship. `final` releases any remaining authorized amount. */
export async function captureAuthorization(
	creds: PayPalCreds,
	authorizationId: string,
	requestId: string,
	opts: { invoiceId?: string; amountCents?: number; final?: boolean } = {},
): Promise<CaptureResult> {
	const cap = await run(() =>
		sdk(creds).payments.captureAuthorizedPayment({
			authorizationId,
			paypalRequestId: requestId,
			prefer: "return=representation",
			body: {
				invoiceId: opts.invoiceId,
				amount: opts.amountCents !== undefined ? money(opts.amountCents) : undefined,
				finalCapture: opts.final ?? true,
			},
		}),
	);
	return { captureId: cap.id!, status: cap.status ?? "UNKNOWN", amountCents: cents(cap.amount?.value) };
}

export async function voidAuthorization(creds: PayPalCreds, authorizationId: string): Promise<void> {
	await run(() => sdk(creds).payments.voidPayment({ authorizationId }));
}

export async function reauthorize(
	creds: PayPalCreds,
	authorizationId: string,
	requestId: string,
): Promise<AuthorizeResult> {
	const a = await run(() => sdk(creds).payments.reauthorizePayment({ authorizationId, paypalRequestId: requestId }));
	return { authorizationId: a.id!, status: a.status ?? "UNKNOWN", amountCents: cents(a.amount?.value) };
}

export type RefundResult = { refundId: string; status: string };

export async function refundCapture(
	creds: PayPalCreds,
	captureId: string,
	requestId: string,
	opts: { amountCents?: number; note?: string; invoiceId?: string } = {},
): Promise<RefundResult> {
	const r = await run(() =>
		sdk(creds).payments.refundCapturedPayment({
			captureId,
			paypalRequestId: requestId,
			prefer: "return=representation",
			body: {
				amount: opts.amountCents !== undefined ? money(opts.amountCents) : undefined,
				noteToPayer: opts.note,
				invoiceId: opts.invoiceId,
			},
		}),
	);
	return { refundId: r.id!, status: r.status ?? "COMPLETED" };
}

// ---- tracking -----------------------------------------------------------

const CARRIERS: Record<string, ShipmentCarrier> = {
	UPS: ShipmentCarrier.Ups,
	USPS: ShipmentCarrier.Usps,
	FEDEX: ShipmentCarrier.Fedex,
};

/** Post shipment tracking against a captured order (seller protection + buyer visibility). Returns PayPal's tracker id. */
export async function addTracking(
	creds: PayPalCreds,
	orderId: string,
	t: { captureId: string; carrier: string; trackingNumber: string; notifyPayer?: boolean },
): Promise<string | undefined> {
	const known = CARRIERS[t.carrier.toUpperCase()];
	const order = await run(() =>
		sdk(creds).orders.createOrderTracking({
			id: orderId,
			body: {
				captureId: t.captureId,
				trackingNumber: t.trackingNumber,
				carrier: known ?? ShipmentCarrier.Other,
				carrierNameOther: known ? undefined : t.carrier,
				notifyPayer: t.notifyPayer ?? true,
			},
		}),
	);
	const trackers = order.purchaseUnits?.[0]?.shipping?.trackers ?? [];
	return trackers.at(-1)?.id;
}
