/**
 * Cart service: the merchant side of PayPal's Cart API v1 (the Store Sync contract).
 *
 *   POST /merchant-cart                 createCart
 *   GET  /merchant-cart/{id}            getCart
 *   PUT  /merchant-cart/{id}            updateCart   (full replacement)
 *   POST /merchant-cart/{id}/checkout   checkoutCart
 *
 * PayPal order lifecycle, following the Store Sync Orders v2 pattern:
 *   - a PayPal order exists once the cart is valid; its id is `payment_method.token`
 *   - cart changes PATCH the order; if the buyer already approved a smaller amount,
 *     or the order can no longer be patched, a fresh order (and approval) is issued
 *   - checkout re-validates live stock, prices and coupons, then
 *       reserve (stock + coupons + PENDING order, one transaction)
 *       -> charge (authorize, or capture in capture mode; idempotent request ids)
 *       -> confirm (order AUTHORIZED/CAPTURED, cart COMPLETED)
 *     and compensates the reservation if PayPal declines.
 */
import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
	type ApiError,
	CART_ID_PATTERN,
	CartRequest,
	CheckoutRequest,
	PayPalCart,
	type ValidationIssue,
} from "@/src/cart-spec/schema";
import { db } from "@/src/db/client";
import { cartEvents, carts, orderItems, orders } from "@/src/db/schema";
import { publish } from "@/src/events/bus";
import { log } from "@/src/log";
import { type ApiResult, badRequest, HttpError, notFound, unprocessable } from "@/src/merchant/api/http";
import type { CartCaller } from "@/src/merchant/auth/jwt-verify";
import { PayPalError } from "@/src/merchant/paypal/http";
import * as paypal from "@/src/merchant/paypal/orders";
import { type Evaluation, evaluateCart } from "./engine";
import { toCents } from "./money";
import * as repo from "./repo";
import type { CatalogVariant } from "./types";

const publicUrl = () => process.env.PUBLIC_URL ?? "http://localhost:3000";

type PaymentState = { orderId: string; approvalUrl?: string; amountCents: number };

// ---------------------------------------------------------------- create / get / update

export async function createCart(store: string, body: unknown, caller: CartCaller): Promise<ApiResult> {
	const request = CartRequest.parse(body);
	const m = await requireMerchant(store);
	const id = `CART-${ulid()}`;
	const { evaluation } = await evaluate(m, id, request);
	const pay = evaluation.valid ? await syncPayPalOrder(m, id, 0, evaluation) : undefined;
	const cart = cartBody(id, evaluation, pay);

	await db().transaction(async (tx) => {
		await tx.insert(carts).values({
			id,
			merchantId: m.id,
			status: cart.status!,
			validationStatus: cart.validation_status!,
			request: request as Record<string, unknown>,
			payload: cart as Record<string, unknown>,
			paypalOrderId: pay?.orderId,
			approvalUrl: pay?.approvalUrl,
			paypalAmountCents: pay?.amountCents,
			jwtSub: caller.subject,
		});
		await tx.insert(cartEvents).values(event(id, "created", cart));
	});
	announce(m.id, cart, evaluation);
	// Spec: 201 for a created cart, including one that comes back with validation issues.
	return { status: 201, body: cart };
}

export async function getCart(store: string, cartId: string): Promise<ApiResult> {
	const m = await requireMerchant(store);
	const row = await requireCart(m.id, cartId);
	return { status: 200, body: row.payload };
}

export async function updateCart(store: string, cartId: string, body: unknown): Promise<ApiResult> {
	checkCartId(cartId);
	const request = CartRequest.parse(body);
	const m = await requireMerchant(store);
	const row = await requireCart(m.id, cartId);
	if (row.status === "COMPLETED") throw alreadyCompleted(cartId);

	const { evaluation } = await evaluate(m, cartId, request);
	const current = paymentOf(row);
	const pay = evaluation.valid ? await syncPayPalOrder(m, cartId, row.version + 1, evaluation, current) : current;
	const cart = cartBody(cartId, evaluation, pay);

	const saved = await db().transaction(async (tx) => {
		const ok = await repo.updateCartIfVersion(tx, cartId, row.version, {
			status: cart.status!,
			validationStatus: cart.validation_status!,
			request: request as Record<string, unknown>,
			payload: cart as Record<string, unknown>,
			paypalOrderId: pay?.orderId ?? null,
			approvalUrl: pay?.approvalUrl ?? null,
			paypalAmountCents: pay?.amountCents ?? null,
		});
		if (ok) await tx.insert(cartEvents).values(event(cartId, "updated", cart));
		return ok;
	});
	if (!saved) throw conflict();
	announce(m.id, cart, evaluation);
	return { status: 200, body: cart };
}

// ---------------------------------------------------------------- checkout

export async function checkoutCart(
	store: string,
	cartId: string,
	body: unknown,
	caller: CartCaller,
): Promise<ApiResult> {
	checkCartId(cartId);
	const { payment_method } = CheckoutRequest.parse(body);
	const token = payment_method.token;
	const payerId = payment_method.payer_id;
	if (!token) throw badRequest("payment_method.token is required", "payment_method.token", "MISSING_REQUIRED_FIELD");
	if (!payerId)
		throw badRequest(
			"Payer ID is required after PayPal payment approval",
			"payment_method.payer_id",
			"MISSING_REQUIRED_FIELD",
		);

	const m = await requireMerchant(store);
	const row = await requireCart(m.id, cartId);

	if (row.status === "COMPLETED") {
		// Replaying a successful checkout returns the same result (idempotent).
		if (row.paypalOrderId === token) return { status: 200, body: row.payload };
		throw alreadyCompleted(cartId);
	}
	if (token !== row.paypalOrderId)
		throw badRequest("PayPal token does not belong to this cart", "payment_method.token", "INVALID_TOKEN");

	// 1. Re-validate against live stock, prices and coupons.
	const request = CartRequest.parse(row.request);
	const { evaluation, catalog } = await evaluate(m, cartId, request);
	if (!evaluation.valid) {
		await saveQuietly(row, cartBody(cartId, evaluation, paymentOf(row)), request);
		throw unprocessable("Cart is not ready for checkout", details(evaluation.cart.validation_issues ?? []));
	}

	// 2. The buyer must have approved exactly this order and amount.
	const creds = repo.credsFor(m);
	const order = await paypal.getOrder(creds, token);
	if (order.status !== "APPROVED")
		throw unprocessable("The buyer has not approved this payment yet", [
			{
				field: "payment_method",
				issue: "PAYER_ACTION_REQUIRED",
				description: `Approve at ${row.approvalUrl ?? "the approval_url"}`,
			},
		]);
	if (order.payer?.payerId && order.payer.payerId !== payerId)
		throw badRequest("payer_id does not match the approved order", "payment_method.payer_id", "INVALID_PAYER");
	const approvedCents = toCents(order.purchaseUnits?.[0]?.amount?.value ?? "0");
	if (approvedCents !== evaluation.totals.totalCents)
		throw unprocessable("Cart total changed after approval; update the cart and approve again", [
			{
				field: "totals.total",
				issue: "AMOUNT_CHANGED",
				description: `Approved ${approvedCents / 100}, cart is now ${evaluation.totals.totalCents / 100}`,
			},
		]);

	// 3. Reserve stock and coupons, record a PENDING order.
	const orderId = await reserve(m.id, cartId, token, request, evaluation, catalog, String(caller.payload.iss ?? ""));

	// 4. Charge. Request ids make retries safe: PayPal returns the original result.
	let charge: { authorizationId?: string; captureId?: string; status: string };
	try {
		charge =
			m.paymentMode === "capture"
				? await paypal.captureOrder(creds, token, `${cartId}-capture`)
				: await paypal.authorizeOrder(creds, token, `${cartId}-authorize`);
	} catch (e) {
		await release(m.id, orderId, evaluation, catalog);
		await db()
			.insert(cartEvents)
			.values(event(cartId, "paypal_error", { error: errSummary(e) }));
		throw chargeFailure(e, row.approvalUrl);
	}

	// 5. Confirm.
	const completed = PayPalCart.parse({
		id: cartId,
		...evaluation.cart,
		status: "COMPLETED",
		validation_status: "VALID",
		validation_issues: [],
		payment_method: { type: "paypal", token, payer_id: payerId },
		payment_confirmation: {
			merchant_order_number: orderId,
			order_review_page: `${publicUrl()}/m/${m.id}/orders/${orderId}`,
		},
	});
	const status = m.paymentMode === "capture" ? "CAPTURED" : "AUTHORIZED";
	await db().transaction(async (tx) => {
		await tx
			.update(orders)
			.set({
				status,
				authorizationId: charge.authorizationId,
				captureId: charge.captureId,
				capturedAt: charge.captureId ? new Date() : null,
			})
			.where(eq(orders.id, orderId));
		await tx
			.update(carts)
			.set({
				status: "COMPLETED",
				validationStatus: "VALID",
				payload: completed as Record<string, unknown>,
				payerId,
				version: row.version + 1,
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(carts.id, cartId));
		await tx.insert(cartEvents).values(
			event(cartId, "checkout", {
				order: orderId,
				order_status: status,
				paypal_status: charge.status,
				authorization_id: charge.authorizationId,
				capture_id: charge.captureId,
			}),
		);
	});
	publish({ type: "order", store: m.id, orderId, status, totalCents: evaluation.totals.totalCents });
	log.info({ store: m.id, cartId, orderId, status, total: evaluation.totals.totalCents }, "checkout completed");
	return { status: 200, body: completed };
}

async function reserve(
	merchantId: string,
	cartId: string,
	paypalOrderId: string,
	request: CartRequest,
	evaluation: Evaluation,
	catalog: Map<string, CatalogVariant>,
	agentPlatform: string,
): Promise<string> {
	return db().transaction(async (tx) => {
		const orderId = await repo.nextOrderNumber(tx);
		const inserted = await tx
			.insert(orders)
			.values({
				id: orderId,
				cartId,
				merchantId,
				paypalOrderId,
				status: "PENDING",
				totalCents: evaluation.totals.totalCents,
				totals: evaluation.cart.totals as Record<string, unknown>,
				buyer: (request.customer ?? null) as Record<string, unknown> | null,
				shipTo: (request.shipping_address ?? null) as Record<string, unknown> | null,
				source: "agent",
				agentPlatform: agentPlatform || null,
			})
			.onConflictDoNothing({ target: orders.paypalOrderId })
			.returning({ id: orders.id });
		if (inserted.length === 0)
			throw new HttpError(409, { name: "CHECKOUT_IN_PROGRESS", message: "This cart is already being checked out" });

		for (const line of evaluation.lines) {
			// back-orders and pre-orders are not drawn from on-hand stock
			if (catalog.get(line.sku)?.availability !== "in_stock") continue;
			if (!(await repo.reserveStock(tx, line.sku, line.quantity)))
				throw unprocessable("Item became out of stock during checkout", [
					{
						field: `items[${line.sku}]`,
						issue: "ITEM_OUT_OF_STOCK",
						description: `${line.name} sold out during checkout`,
					},
				]);
		}
		for (const c of evaluation.cart.applied_coupons ?? []) {
			if (!(await repo.consumeCoupon(tx, merchantId, c.code)))
				throw unprocessable("Coupon was used up during checkout", [
					{ field: "coupons", issue: "DISCOUNT_USAGE_LIMIT_EXCEEDED", description: `${c.code} is no longer available` },
				]);
		}
		await tx.insert(orderItems).values(
			evaluation.lines.map((l, i) => ({
				id: `${orderId}-${i + 1}`,
				orderId,
				variantId: l.sku,
				qty: l.quantity,
				unitCents: l.unitCents,
				title: l.name,
				stockReserved: catalog.get(l.sku)?.availability === "in_stock",
			})),
		);
		return orderId;
	});
}

/** Undo a reservation after PayPal declined: stock and coupons back, PENDING order removed. */
async function release(
	merchantId: string,
	orderId: string,
	evaluation: Evaluation,
	catalog: Map<string, CatalogVariant>,
) {
	await db().transaction(async (tx) => {
		for (const line of evaluation.lines) {
			if (catalog.get(line.sku)?.availability === "in_stock") await repo.releaseStock(tx, line.sku, line.quantity);
		}
		for (const c of evaluation.cart.applied_coupons ?? []) await repo.releaseCoupon(tx, merchantId, c.code);
		await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
		await tx.delete(orders).where(eq(orders.id, orderId));
	});
}

const DECLINES = new Set(["INSTRUMENT_DECLINED", "PAYER_CANNOT_PAY", "TRANSACTION_REFUSED", "PAYER_ACTION_REQUIRED"]);

function chargeFailure(e: unknown, approvalUrl: string | null): Error {
	if (!(e instanceof PayPalError)) return e as Error;
	if (e.issue && DECLINES.has(e.issue))
		return unprocessable("Payment was declined", [
			{
				field: "payment_method",
				issue: "PAYMENT_DECLINED",
				description: `PayPal ${e.issue}: the buyer can choose another funding source at ${approvalUrl ?? "the approval_url"}`,
			},
		]);
	if (e.status >= 500)
		return new HttpError(500, {
			name: "PAYMENT_PROCESSOR_ERROR",
			message: "PayPal is unavailable; retry the checkout",
			details: [
				{
					field: "payment_method",
					issue: "PAYMENT_PROCESSOR_UNAVAILABLE",
					description: `PayPal debug_id ${e.debugId ?? "n/a"}`,
				},
			],
		});
	return unprocessable("Payment could not be completed", [
		{ field: "payment_method", issue: e.issue ?? e.name, description: `PayPal debug_id ${e.debugId ?? "n/a"}` },
	]);
}

// ---------------------------------------------------------------- PayPal order sync

async function syncPayPalOrder(
	m: repo.Merchant,
	cartId: string,
	version: number,
	ev: Evaluation,
	current?: PaymentState,
): Promise<PaymentState> {
	const creds = repo.credsFor(m);
	const create = async (): Promise<PaymentState> => {
		const o = await paypal.createOrder(creds, {
			mode: m.paymentMode === "capture" ? "capture" : "authorize",
			requestId: `${cartId}-v${version}`,
			invoiceId: `${cartId}-v${version}`,
			customId: cartId,
			lines: ev.lines,
			totals: ev.totals,
			shipTo: ev.shipTo,
			returnUrl: approvalReturn("return", m.id, cartId),
			cancelUrl: approvalReturn("cancel", m.id, cartId),
			brandName: m.name,
		});
		return { orderId: o.id, approvalUrl: o.approvalUrl, amountCents: ev.totals.totalCents };
	};
	if (!current) return create();

	const order = await paypal.getOrder(creds, current.orderId);
	const approvedCents = toCents(order.purchaseUnits?.[0]?.amount?.value ?? "0");
	const patchable =
		order.status === "CREATED" || order.status === "APPROVED" || order.status === "PAYER_ACTION_REQUIRED";
	// Never take more than the buyer approved: a larger total needs a fresh approval.
	if (!patchable || (order.status === "APPROVED" && ev.totals.totalCents > approvedCents)) return create();
	try {
		await paypal.patchOrder(creds, current.orderId, { totals: ev.totals, lines: ev.lines, shipTo: ev.shipTo });
	} catch (e) {
		if (e instanceof PayPalError && e.status === 422) return create();
		throw e;
	}
	return { ...current, amountCents: ev.totals.totalCents };
}

function approvalReturn(kind: "return" | "cancel", store: string, cartId: string): string {
	const base =
		(kind === "return" ? process.env.PAYPAL_RETURN_URL : process.env.PAYPAL_CANCEL_URL) ??
		`${publicUrl()}/paypal/${kind}`;
	const u = new URL(base);
	u.searchParams.set("store", store);
	u.searchParams.set("cart_id", cartId);
	return u.toString();
}

// ---------------------------------------------------------------- helpers

async function requireMerchant(id: string): Promise<repo.Merchant> {
	const m = await repo.getMerchant(id);
	if (!m) throw notFound("STORE_NOT_FOUND", `Store '${id}' does not exist`);
	return m;
}

async function requireCart(merchantId: string, cartId: string): Promise<repo.CartRow> {
	checkCartId(cartId);
	const row = await repo.getCartRow(merchantId, cartId);
	if (!row)
		throw new HttpError(404, {
			name: "CART_NOT_FOUND",
			message: `Cart with ID '${cartId}' does not exist`,
			details: [{ field: "cartId", issue: "NOT_FOUND", description: "Verify the cart ID or create a new cart." }],
		});
	return row;
}

function checkCartId(cartId: string) {
	if (!CART_ID_PATTERN.test(cartId))
		throw new HttpError(400, {
			name: "INVALID_CART_ID",
			message: "Cart ID format is invalid. Expected format: CART-[A-Z0-9]+",
			details: [{ field: "cartId", issue: "INVALID_FORMAT", description: `Provided: ${cartId.slice(0, 64)}` }],
		});
}

async function evaluate(m: repo.Merchant, cartId: string, request: CartRequest) {
	const ids = request.items.map((i) => i.variant_id ?? i.item_id).filter((x): x is string => Boolean(x));
	const [catalog, coupons] = await Promise.all([
		repo.loadCatalog(m.id, ids),
		repo.loadCoupons(
			m.id,
			(request.coupons ?? []).map((c) => c.code),
		),
	]);
	const evaluation = evaluateCart({ request, catalog, policy: m.policy, coupons, cartId, now: new Date() });
	return { evaluation, catalog };
}

/** The response body. Validated against the spec schema so we never emit a non-conformant cart. */
function cartBody(id: string, ev: Evaluation, pay?: PaymentState): PayPalCart {
	return PayPalCart.parse({
		id,
		...ev.cart,
		// A payment token is only offered for a checkout-ready cart.
		payment_method:
			ev.valid && pay
				? { type: "paypal", token: pay.orderId, ...(pay.approvalUrl && { approval_url: pay.approvalUrl }) }
				: { type: "paypal" },
	});
}

const paymentOf = (row: repo.CartRow): PaymentState | undefined =>
	row.paypalOrderId
		? { orderId: row.paypalOrderId, approvalUrl: row.approvalUrl ?? undefined, amountCents: row.paypalAmountCents ?? 0 }
		: undefined;

/** Persist a re-evaluated cart so GET shows current issues; a concurrent writer wins silently. */
async function saveQuietly(row: repo.CartRow, cart: PayPalCart, request: CartRequest) {
	await db().transaction((tx) =>
		repo.updateCartIfVersion(tx, row.id, row.version, {
			status: cart.status!,
			validationStatus: cart.validation_status!,
			request: request as Record<string, unknown>,
			payload: cart as Record<string, unknown>,
		}),
	);
}

function details(issues: ValidationIssue[]): ApiError["details"] {
	return issues.map((i) => ({
		field: i.field ?? (i.variant_id ? `items[${i.variant_id}]` : undefined),
		issue: String((i.context as { specific_issue?: string } | undefined)?.specific_issue ?? i.code),
		description: i.user_message ?? i.message,
	}));
}

const alreadyCompleted = (cartId: string) =>
	unprocessable("Cart is already checked out", [
		{ field: "cartId", issue: "CART_ALREADY_COMPLETED", description: `${cartId} was completed; create a new cart` },
	]);

const conflict = () =>
	new HttpError(409, {
		name: "CART_MODIFIED",
		message: "The cart changed while this request was processed; GET it and retry",
	});

function event(cartId: string, kind: string, data: unknown) {
	const d = data as PayPalCart;
	return {
		id: ulid(),
		cartId,
		kind,
		data: (d?.validation_status
			? {
					status: d.status,
					validation_status: d.validation_status,
					total: d.totals?.total.value,
					issues: (d.validation_issues ?? []).map(
						(i) => (i.context as { specific_issue?: string } | undefined)?.specific_issue ?? i.code,
					),
				}
			: data) as Record<string, unknown>,
	};
}

function announce(store: string, cart: PayPalCart, ev: Evaluation) {
	publish({
		type: "cart",
		store,
		cartId: cart.id!,
		status: cart.status!,
		totalCents: ev.totals.totalCents,
		issues: (cart.validation_issues ?? []).map((i) =>
			String((i.context as { specific_issue?: string } | undefined)?.specific_issue ?? i.code),
		),
	});
}

function errSummary(e: unknown) {
	return e instanceof PayPalError
		? { status: e.status, name: e.name, issue: e.issue, debug_id: e.debugId }
		: { message: (e as Error).message };
}
