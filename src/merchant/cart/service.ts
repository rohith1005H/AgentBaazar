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
 *   - checkout re-validates live stock, prices and coupons, checks the PayPal order is
 *     APPROVED by this payer for exactly the cart total, then
 *       reserve  one transaction: claim the cart version (concurrent PUTs now get 409),
 *                take stock and coupons, insert a PENDING order with a snapshot of the cart
 *       charge   authorize (or capture in capture mode) with a request id derived from the
 *                cart, so PayPal never charges twice for one cart
 *       confirm  only if PayPal's status and amount match: order AUTHORIZED/CAPTURED,
 *                cart COMPLETED
 *   - a decline (or a non-success status) releases the reservation; a mismatched amount
 *     is voided/refunded, then released; a lost response (timeout, 5xx) keeps the
 *     reservation, and a retry after CHECKOUT_STALE_MS resumes it with the same request id.
 */
import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
	type ApiError,
	CART_ID_PATTERN,
	CartRequest,
	CheckoutRequest,
	PayPalCart,
	type ValidationIssue,
} from "@/src/cart-spec/schema";
import { signLink } from "@/src/crypto";
import { db } from "@/src/db/client";
import { cartEvents, carts, orderItems, orders } from "@/src/db/schema";
import { publish } from "@/src/events/bus";
import { log } from "@/src/log";
import { type ApiResult, badRequest, HttpError, unprocessable } from "@/src/merchant/api/http";
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

export async function createCart(m: repo.Merchant, body: unknown, caller: CartCaller): Promise<ApiResult> {
	const request = CartRequest.parse(body);
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
	// Spec (createCart): 201 with a payment token when the cart is ready, 200 + validation_issues otherwise.
	return { status: evaluation.valid ? 201 : 200, body: cart };
}

export async function getCart(m: repo.Merchant, cartId: string, caller: CartCaller): Promise<ApiResult> {
	const row = await requireCart(m.id, cartId, caller);
	return { status: 200, body: row.payload };
}

export async function updateCart(
	m: repo.Merchant,
	cartId: string,
	body: unknown,
	caller: CartCaller,
): Promise<ApiResult> {
	checkCartId(cartId);
	const request = CartRequest.parse(body);
	const row = await requireCart(m.id, cartId, caller);
	if (row.status === "COMPLETED") throw alreadyCompleted(cartId);
	// Do not touch the PayPal order while a checkout holds it.
	if (row.paypalOrderId && (await repo.orderForPayPalOrder(row.paypalOrderId))) throw checkoutInProgress();

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

/** A PENDING order older than this, with no live request behind it, is resumed by the next checkout. */
const staleAfterMs = () => Number(process.env.CHECKOUT_STALE_MS ?? 30_000);

type Charge = { authorizationId?: string; captureId?: string; status: string; amountCents: number };

export async function checkoutCart(
	m: repo.Merchant,
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

	const row = await requireCart(m.id, cartId, caller);
	if (row.status === "COMPLETED") {
		// Replaying a successful checkout returns the same result (idempotent).
		if (row.paypalOrderId === token) return { status: 200, body: row.payload };
		throw alreadyCompleted(cartId);
	}
	if (token !== row.paypalOrderId)
		throw badRequest("PayPal token does not belong to this cart", "payment_method.token", "INVALID_TOKEN");

	const creds = repo.credsFor(m);
	const existing = await repo.orderForPayPalOrder(token);
	let order: repo.OrderRow;
	let snapshot: PayPalCart;

	if (existing) {
		// An earlier attempt reserved stock but did not finish. Resume it: the charge below
		// reuses that attempt's PayPal-Request-Id, so PayPal returns the original result
		// instead of charging twice.
		if (existing.status !== "PENDING") return finishWithoutCharge(m, row, existing);
		if (Date.now() - existing.createdAt.getTime() < staleAfterMs()) throw checkoutInProgress();
		order = existing;
		snapshot = PayPalCart.parse(row.payload);
	} else {
		// 1. Re-validate against live stock, prices and coupons.
		const request = CartRequest.parse(row.request);
		const { evaluation, catalog } = await evaluate(m, cartId, request);
		if (!evaluation.valid) {
			await saveQuietly(row, cartBody(cartId, evaluation, paymentOf(row)), request);
			throw unprocessable("Cart is not ready for checkout", details(evaluation.cart.validation_issues ?? []));
		}

		// 2. The buyer must have approved exactly this order and amount.
		const paypalOrder = await paypal.getOrder(creds, token);
		if (paypalOrder.status !== "APPROVED")
			throw unprocessable("The buyer has not approved this payment yet", [
				{
					field: "payment_method",
					issue: "PAYER_ACTION_REQUIRED",
					description: `Approve at ${row.approvalUrl ?? "the approval_url"}`,
				},
			]);
		if (paypalOrder.payer?.payerId && paypalOrder.payer.payerId !== payerId)
			throw badRequest("payer_id does not match the approved order", "payment_method.payer_id", "INVALID_PAYER");
		const approvedCents = toCents(paypalOrder.purchaseUnits?.[0]?.amount?.value ?? "0");
		if (approvedCents !== evaluation.totals.totalCents)
			throw amountChanged(approvedCents, evaluation.totals.totalCents);

		// 3. Reserve stock and coupons, record a PENDING order, and claim the cart version
		//    so a concurrent PUT can no longer change it.
		snapshot = cartBody(cartId, evaluation, paymentOf(row));
		order = await reserve(m.id, row, request, evaluation, catalog, snapshot, String(caller.payload.iss ?? ""));
	}

	// 4. Charge (authorize, or capture in capture mode). Idempotent per cart.
	let charge: Charge;
	try {
		charge =
			m.paymentMode === "capture"
				? await paypal.captureOrder(creds, token, `${cartId}-capture`)
				: await paypal.authorizeOrder(creds, token, `${cartId}-authorize`);
	} catch (e) {
		await recordEvent(cartId, "paypal_error", { error: errSummary(e) });
		if (e instanceof PayPalError && e.status < 500) {
			await release(m.id, order.id);
			throw chargeFailure(e, row.approvalUrl);
		}
		// Outcome unknown (timeout, network, PayPal 5xx after retries): keep the reservation so a
		// retry resumes this exact payment rather than orphaning an authorization.
		throw new HttpError(502, {
			name: "PAYMENT_PROCESSOR_ERROR",
			message: "PayPal did not confirm the payment; retry checkout to resume it",
			details: [{ field: "payment_method", issue: "PAYMENT_PROCESSOR_UNAVAILABLE", description: errText(e) }],
		});
	}

	// 5. Trust PayPal's answer, not our expectation: status and amount must match.
	const accepted = m.paymentMode === "capture" ? ["COMPLETED", "PENDING"] : ["CREATED", "PENDING"];
	if (!accepted.includes(charge.status)) {
		await release(m.id, order.id);
		await recordEvent(cartId, "paypal_error", { declined_status: charge.status });
		throw unprocessable("Payment was declined", [
			{ field: "payment_method", issue: "PAYMENT_DECLINED", description: `PayPal returned ${charge.status}` },
		]);
	}
	if (charge.amountCents !== order.totalCents) {
		// The PayPal order changed under us (e.g. a concurrent cart update patched it). Undo the charge.
		if (charge.authorizationId) await paypal.voidAuthorization(creds, charge.authorizationId);
		if (charge.captureId)
			await paypal.refundCapture(creds, charge.captureId, `${cartId}-mismatch-refund`, {
				note: "Cart changed during checkout",
			});
		await release(m.id, order.id);
		await recordEvent(cartId, "paypal_error", {
			amount_mismatch: { charged: charge.amountCents, expected: order.totalCents },
		});
		throw new HttpError(409, {
			name: "CART_CHANGED_DURING_CHECKOUT",
			message:
				"The cart changed while it was being paid for; the payment was released. GET the cart and approve again.",
		});
	}

	// 6. Confirm.
	const status =
		m.paymentMode === "capture"
			? charge.status === "COMPLETED"
				? "CAPTURED"
				: "CAPTURE_PENDING"
			: charge.status === "CREATED"
				? "AUTHORIZED"
				: "PAYMENT_PENDING";
	return confirm(m, row, order, snapshot, { ...charge, orderStatus: status, payerId });
}

/**
 * Write the outcome: order status and PayPal ids, cart COMPLETED with the spec's
 * payment_confirmation. Only a PENDING order is moved, so two confirms cannot race.
 */
async function confirm(
	m: repo.Merchant,
	row: repo.CartRow,
	order: repo.OrderRow,
	snapshot: PayPalCart,
	c: Charge & { orderStatus: string; payerId: string },
): Promise<ApiResult> {
	const completed = completedCart(m, row.id, order.id, snapshot, row.paypalOrderId!, c.payerId);
	await db().transaction(async (tx) => {
		await tx
			.update(orders)
			.set({
				status: c.orderStatus,
				authorizationId: c.authorizationId,
				captureId: c.captureId,
				capturedAt: c.captureId ? new Date() : null,
			})
			.where(and(eq(orders.id, order.id), eq(orders.status, "PENDING")));
		await tx
			.update(carts)
			.set({
				status: "COMPLETED",
				validationStatus: "VALID",
				payload: completed as Record<string, unknown>,
				payerId: c.payerId,
				completedAt: new Date(),
				updatedAt: new Date(),
			})
			.where(eq(carts.id, row.id));
		await tx.insert(cartEvents).values(
			event(row.id, "checkout", {
				order: order.id,
				order_status: c.orderStatus,
				paypal_status: c.status,
				authorization_id: c.authorizationId,
				capture_id: c.captureId,
			}),
		);
	});
	publish({ type: "order", store: m.id, orderId: order.id, status: c.orderStatus, totalCents: order.totalCents });
	log.info({ store: m.id, cartId: row.id, orderId: order.id, status: c.orderStatus }, "checkout completed");
	return { status: 200, body: completed };
}

/** The order was already charged but the cart was never marked complete (crash between the two writes). */
async function finishWithoutCharge(m: repo.Merchant, row: repo.CartRow, order: repo.OrderRow): Promise<ApiResult> {
	if (!["AUTHORIZED", "CAPTURED", "PAYMENT_PENDING", "CAPTURE_PENDING"].includes(order.status))
		throw alreadyCompleted(row.id);
	const completed = completedCart(
		m,
		row.id,
		order.id,
		PayPalCart.parse(row.payload),
		row.paypalOrderId!,
		row.payerId ?? undefined,
	);
	await db()
		.update(carts)
		.set({
			status: "COMPLETED",
			validationStatus: "VALID",
			payload: completed as Record<string, unknown>,
			completedAt: new Date(),
		})
		.where(eq(carts.id, row.id));
	return { status: 200, body: completed };
}

function completedCart(
	m: repo.Merchant,
	cartId: string,
	orderId: string,
	snapshot: PayPalCart,
	token: string,
	payerId?: string,
): PayPalCart {
	return PayPalCart.parse({
		...snapshot,
		id: cartId,
		status: "COMPLETED",
		validation_status: "VALID",
		validation_issues: [],
		payment_method: { type: "paypal", token, ...(payerId && { payer_id: payerId }) },
		payment_confirmation: { merchant_order_number: orderId, order_review_page: orderReviewUrl(m.id, orderId) },
	});
}

async function reserve(
	merchantId: string,
	row: repo.CartRow,
	request: CartRequest,
	evaluation: Evaluation,
	catalog: Map<string, CatalogVariant>,
	snapshot: PayPalCart,
	agentPlatform: string,
): Promise<repo.OrderRow> {
	return db().transaction(async (tx) => {
		// Claim the cart: any PUT that read the old version now fails with 409.
		const claimed = await repo.updateCartIfVersion(tx, row.id, row.version, {
			payload: snapshot as Record<string, unknown>,
		});
		if (!claimed) throw conflict();

		const orderId = await repo.nextOrderNumber(tx);
		const [order] = await tx
			.insert(orders)
			.values({
				id: orderId,
				cartId: row.id,
				merchantId,
				paypalOrderId: row.paypalOrderId!,
				status: "PENDING",
				totalCents: evaluation.totals.totalCents,
				totals: evaluation.cart.totals as Record<string, unknown>,
				buyer: (request.customer ?? null) as Record<string, unknown> | null,
				shipTo: (request.shipping_address ?? null) as Record<string, unknown> | null,
				source: "agent",
				agentPlatform: agentPlatform || null,
			})
			.onConflictDoNothing({ target: orders.paypalOrderId })
			.returning();
		if (!order) throw checkoutInProgress();

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
		const coupons = (evaluation.cart.applied_coupons ?? []).map((c) => c.code);
		for (const code of coupons) {
			if (!(await repo.consumeCoupon(tx, merchantId, code)))
				throw unprocessable("Coupon was used up during checkout", [
					{ field: "coupons", issue: "DISCOUNT_USAGE_LIMIT_EXCEEDED", description: `${code} is no longer available` },
				]);
		}
		await tx.update(orders).set({ couponCodes: coupons }).where(eq(orders.id, orderId));
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
		return { ...order, couponCodes: coupons };
	});
}

/**
 * Undo a reservation after PayPal declined: stock and coupons back, PENDING order removed.
 * Works from what the order recorded, so it is exact even if the catalog changed since.
 */
async function release(merchantId: string, orderId: string) {
	await db().transaction(async (tx) => {
		const [order] = await tx
			.select()
			.from(orders)
			.where(and(eq(orders.id, orderId), eq(orders.status, "PENDING")))
			.for("update");
		if (!order) return;
		const items = await tx.delete(orderItems).where(eq(orderItems.orderId, orderId)).returning();
		await tx.delete(orders).where(eq(orders.id, orderId));
		for (const i of items) if (i.stockReserved) await repo.releaseStock(tx, i.variantId, i.qty);
		for (const code of order.couponCodes ?? []) await repo.releaseCoupon(tx, merchantId, code);
	});
}

const DECLINES = new Set(["INSTRUMENT_DECLINED", "PAYER_CANNOT_PAY", "TRANSACTION_REFUSED", "PAYER_ACTION_REQUIRED"]);

function chargeFailure(e: PayPalError, approvalUrl: string | null): Error {
	if (e.issue && DECLINES.has(e.issue))
		return unprocessable("Payment was declined", [
			{
				field: "payment_method",
				issue: "PAYMENT_DECLINED",
				description: `PayPal ${e.issue}: the buyer can choose another funding source at ${approvalUrl ?? "the approval_url"}`,
			},
		]);
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

/** Loads a cart of this store. A cart created by another caller is reported as not found. */
async function requireCart(merchantId: string, cartId: string, caller: CartCaller): Promise<repo.CartRow> {
	checkCartId(cartId);
	const row = await repo.getCartRow(merchantId, cartId);
	if (!row || (row.jwtSub && row.jwtSub !== caller.subject))
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

const checkoutInProgress = () =>
	new HttpError(409, { name: "CHECKOUT_IN_PROGRESS", message: "This cart is being checked out; retry shortly" });

const amountChanged = (approvedCents: number, totalCents: number) =>
	unprocessable("Cart total changed after approval; update the cart and approve again", [
		{
			field: "totals.total",
			issue: "AMOUNT_CHANGED",
			description: `Approved ${(approvedCents / 100).toFixed(2)}, cart is now ${(totalCents / 100).toFixed(2)}`,
		},
	]);

/** Signed so the link works for the buyer without exposing other orders to guessing. */
const orderReviewUrl = (store: string, orderId: string) =>
	`${publicUrl()}/m/${store}/orders/${orderId}?k=${signLink(`${store}/${orderId}`)}`;

async function recordEvent(cartId: string, kind: string, data: Record<string, unknown>) {
	await db()
		.insert(cartEvents)
		.values(event(cartId, kind, data));
}

const errText = (e: unknown) =>
	e instanceof PayPalError
		? `PayPal ${e.status} ${e.issue ?? e.name} debug_id ${e.debugId ?? "n/a"}`
		: (e as Error).message;

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
