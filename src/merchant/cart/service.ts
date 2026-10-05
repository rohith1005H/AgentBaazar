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
 *   - cart changes PATCH the order (holding the cart row, so they cannot interleave with a
 *     checkout); if the buyer already approved a smaller amount, or the order can no longer
 *     be patched, a fresh order (and approval) is issued
 *   - checkout re-validates live stock, prices and coupons, checks the PayPal order is
 *     APPROVED by this payer for exactly the cart total, then
 *       reserve  one transaction: claim the cart version (concurrent PUTs now get 409),
 *                take stock and coupons, insert a PENDING order with a snapshot of the cart
 *                and a lease on its charge
 *       charge   authorize (or capture in capture mode) with a request id derived from the
 *                cart, so PayPal never charges twice for one cart
 *       confirm  only if PayPal's status and amount match: order AUTHORIZED/CAPTURED,
 *                cart COMPLETED
 *   - a decline (or a non-success status) releases the reservation; a mismatched amount
 *     is voided/refunded, then released; a lost response (timeout, 5xx) keeps the
 *     reservation, and once its lease (CHECKOUT_LEASE_MS) runs out a retry resumes it:
 *     it reads the payment back from PayPal, or charges with the same request id.
 */
import { randomUUID } from "node:crypto";
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
import { signLink, stableRequestId } from "@/src/crypto";
import { db } from "@/src/db/client";
import { cartEvents, carts, orderItems, orders } from "@/src/db/schema";
import { publish } from "@/src/events/bus";
import { log } from "@/src/log";
import { type ApiResult, badRequest, HttpError, unprocessable } from "@/src/merchant/api/http";
import type { CartCaller } from "@/src/merchant/auth/jwt-verify";
import { type PayPalCreds, PayPalError } from "@/src/merchant/paypal/http";
import * as paypal from "@/src/merchant/paypal/orders";
import { publicUrl } from "@/src/public-url";
import { type Evaluation, evaluateCart } from "./engine";
import { toCents } from "./money";
import * as repo from "./repo";
import type { CatalogVariant } from "./types";

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
	const cart = row.payload as PayPalCart;
	if (row.status === "COMPLETED") return { status: 200, body: cart };
	// A checkout-ready cart reads as READY; once PayPal reports the buyer's approval
	// (CHECKOUT.ORDER.APPROVED webhook) the payer is shown, so the agent knows it can check out.
	return {
		status: 200,
		body: {
			...cart,
			...(cart.status === "CREATED" && { status: "READY" }),
			...(row.payerId &&
				cart.payment_method?.token && { payment_method: { ...cart.payment_method, payer_id: row.payerId } }),
		},
	};
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
	const { evaluation } = await evaluate(m, cartId, request);

	// Lock the cart row while the PayPal order is changed. A checkout claiming the cart waits
	// for the lock and then fails its version check, so a PUT never changes an order that is
	// being paid, and a PUT that loses a race never touches PayPal.
	// ponytail: holds one pooled connection for the PayPal round trip; fine at small-store volume.
	const cart = await db().transaction(async (tx) => {
		const [locked] = await tx
			.select({ id: carts.id })
			.from(carts)
			.where(and(eq(carts.id, cartId), eq(carts.version, row.version)))
			.for("update");
		if (!locked) throw conflict();
		if (row.paypalOrderId && (await repo.orderForPayPalOrder(row.paypalOrderId, tx))) throw checkoutInProgress();

		const current = paymentOf(row);
		const pay = evaluation.valid ? await syncPayPalOrder(m, cartId, row.version + 1, evaluation, current) : current;
		const cart = cartBody(cartId, evaluation, pay, "READY");
		await repo.updateCartIfVersion(tx, cartId, row.version, {
			status: cart.status!,
			validationStatus: cart.validation_status!,
			request: request as Record<string, unknown>,
			payload: cart as Record<string, unknown>,
			paypalOrderId: pay?.orderId ?? null,
			approvalUrl: pay?.approvalUrl ?? null,
			paypalAmountCents: pay?.amountCents ?? null,
			// an approval belongs to one PayPal order
			payerId: pay?.orderId === row.paypalOrderId ? row.payerId : null,
		});
		await tx.insert(cartEvents).values(event(cartId, "updated", cart));
		return cart;
	});
	announce(m.id, cart, evaluation);
	return { status: 200, body: cart };
}

// ---------------------------------------------------------------- checkout

/**
 * How long a checkout owns its PENDING order's charge. Longer than the PayPal SDK's worst
 * case for one call (30 s timeout, 3 retries on 5xx, backoff), so a retry can only resume
 * an attempt that is no longer talking to PayPal.
 */
const leaseMs = () => Number(process.env.CHECKOUT_LEASE_MS ?? 180_000);

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

	let charge: Charge | undefined;

	if (existing) {
		// An earlier attempt reserved stock but did not finish (lost response, crash).
		if (existing.status !== "PENDING") return finishWithoutCharge(m, row, existing);
		// Take over its lease; 409 while that attempt may still be talking to PayPal.
		// ponytail: the lease is taken once, not renewed; an attempt slower than CHECKOUT_LEASE_MS
		// could overlap a later resume (confirm() then voids the loser). Renew it if that ever shows up.
		if (!(await repo.takeChargeLease(existing.id, leaseMs()))) throw checkoutInProgress();
		order = existing;
		snapshot = PayPalCart.parse(row.payload);
		// Ask PayPal what happened before charging. If nothing did, the charge below reuses
		// the attempt's PayPal-Request-Id, so it still cannot charge twice.
		charge = await chargeOnOrder(creds, token, m.paymentMode);
	} else {
		// 1. Re-validate against live stock, prices and coupons.
		const request = CartRequest.parse(row.request);
		const { evaluation, catalog } = await evaluate(m, cartId, request);
		if (!evaluation.valid) {
			const issues = evaluation.cart.validation_issues ?? [];
			await saveQuietly(row, cartBody(cartId, evaluation, paymentOf(row)), request);
			throw unprocessable("Cart is not ready for checkout", details(issues), issues[0]);
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
		order = await reserve(m.id, row, request, evaluation, catalog, snapshot, caller.subject);
	}

	// 4. Charge (authorize, or capture in capture mode). Idempotent per cart.
	if (!charge) {
		try {
			charge =
				m.paymentMode === "capture"
					? await paypal.captureOrder(creds, token, stableRequestId(`${cartId}-capture`))
					: await paypal.authorizeOrder(creds, token, stableRequestId(`${cartId}-authorize`));
		} catch (e) {
			await recordEvent(cartId, "paypal_error", { error: errSummary(e) });
			if (e instanceof PayPalError && e.status < 500) {
				await release(order.id);
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
	}

	// 5. Trust PayPal's answer, not our expectation: status and amount must match.
	const accepted = m.paymentMode === "capture" ? ["COMPLETED", "PENDING"] : ["CREATED", "PENDING"];
	if (!accepted.includes(charge.status)) {
		await release(order.id);
		await recordEvent(cartId, "paypal_error", { declined_status: charge.status });
		throw unprocessable("Payment was declined", [
			{ field: "payment_method", issue: "PAYMENT_DECLINED", description: `PayPal returned ${charge.status}` },
		]);
	}
	if (charge.amountCents !== order.totalCents) {
		// The PayPal order was changed outside this cart's flow. Undo the charge and detach that
		// order from the cart, so the next PUT issues a fresh one for the buyer to approve.
		await undoCharge(creds, cartId, charge);
		await release(order.id);
		await detachPayPalOrder(cartId, token, snapshot);
		await recordEvent(cartId, "paypal_error", {
			amount_mismatch: { charged: charge.amountCents, expected: order.totalCents },
		});
		throw new HttpError(409, {
			name: "CART_CHANGED_DURING_CHECKOUT",
			message:
				"PayPal charged a different amount than the cart total, so the payment was voided. PUT the cart to get a new approval link.",
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
	const kept = await db().transaction(async (tx) => {
		const [moved] = await tx
			.update(orders)
			.set({
				status: c.orderStatus,
				authorizationId: c.authorizationId,
				captureId: c.captureId,
				capturedAt: c.captureId ? new Date() : null,
			})
			.where(and(eq(orders.id, order.id), eq(orders.status, "PENDING")))
			.returning({ id: orders.id });
		// Not PENDING any more: either a webhook recorded this payment first (the order is
		// still there, fine) or another attempt released the reservation (order gone).
		if (!moved && !(await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, order.id))).length)
			return false;
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
		return true;
	});
	if (!kept) {
		// The stock and coupons were handed back, so this payment has no order: undo it.
		await undoCharge(repo.credsFor(m), row.id, c);
		await recordEvent(row.id, "paypal_error", { released_during_charge: order.id });
		throw new HttpError(409, {
			name: "CHECKOUT_CONFLICT",
			message: "Another checkout attempt released this order while PayPal was charging; the payment was voided",
		});
	}
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
				agentPlatform,
				chargingUntil: repo.leaseUntil(leaseMs()),
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
async function release(orderId: string) {
	await db().transaction(async (tx) => {
		const [order] = await tx
			.select()
			.from(orders)
			.where(and(eq(orders.id, orderId), eq(orders.status, "PENDING")))
			.for("update");
		if (!order) return;
		await repo.releaseOrderHoldings(tx, order);
		await tx.delete(orderItems).where(eq(orderItems.orderId, orderId));
		await tx.delete(orders).where(eq(orders.id, orderId));
	});
}

/** Void an authorization or refund a capture that must not stand. */
async function undoCharge(creds: PayPalCreds, cartId: string, c: Charge) {
	try {
		if (c.authorizationId) await paypal.voidAuthorization(creds, c.authorizationId);
		if (c.captureId)
			await paypal.refundCapture(creds, c.captureId, stableRequestId(`${cartId}-undo-${c.captureId}`), {
				note: "Checkout could not be completed",
			});
	} catch (e) {
		// Leave a trail: this payment belongs to no order and has to be voided or refunded by hand.
		const ids = { authorization_id: c.authorizationId, capture_id: c.captureId };
		log.error({ cartId, ...ids, err: errSummary(e) }, "could not undo a charge");
		await recordEvent(cartId, "paypal_error", { undo_failed: { ...ids, error: errSummary(e) } });
		throw e;
	}
}

/** The payment PayPal already made on this order, if any (read back when resuming a checkout). */
async function chargeOnOrder(creds: PayPalCreds, token: string, mode: string): Promise<Charge | undefined> {
	const o = await paypal.getOrder(creds, token);
	const p = o.purchaseUnits?.[0]?.payments;
	const made = mode === "capture" ? p?.captures?.[0] : p?.authorizations?.[0];
	if (!made?.id) return undefined;
	const amountCents = made.amount?.value ? toCents(made.amount.value) : -1;
	return mode === "capture"
		? { captureId: made.id, status: made.status ?? "", amountCents }
		: { authorizationId: made.id, status: made.status ?? "", amountCents };
}

/**
 * Forget a PayPal order whose payment was undone. The cart is not checkout-ready until
 * the buyer approves again; it says so, and the next PUT issues a fresh PayPal order.
 */
async function detachPayPalOrder(cartId: string, token: string, snapshot: PayPalCart) {
	const cart = PayPalCart.parse({
		...snapshot,
		status: "INCOMPLETE",
		validation_status: "INVALID",
		validation_issues: [
			{
				code: "PAYMENT_ERROR",
				type: "BUSINESS_RULE",
				field: "payment_method",
				message: "The PayPal order was voided because it no longer matched the cart",
				user_message: "Please approve the payment again.",
				context: { specific_issue: "PAYMENT_EXPIRED" },
				resolution_options: [
					{
						action: "REQUEST_APPROVAL",
						label: "Update the cart (PUT) to get a new PayPal approval link",
						metadata: { priority: "HIGH" },
					},
				],
			},
		],
		payment_method: { type: "paypal" },
	});
	await db()
		.update(carts)
		.set({
			status: cart.status!,
			validationStatus: cart.validation_status!,
			paypalOrderId: null,
			approvalUrl: null,
			paypalAmountCents: null,
			payerId: null,
			payload: cart as Record<string, unknown>,
			updatedAt: new Date(),
		})
		.where(and(eq(carts.id, cartId), eq(carts.paypalOrderId, token)));
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

/**
 * The buyer came back from PayPal's approval page (return_url). Ask PayPal, not the query
 * string, whether the order is approved and by whom, and record the payer on the cart, so a
 * GET shows `payer_id` right away instead of whenever the CHECKOUT.ORDER.APPROVED webhook lands.
 */
export async function recordBuyerApproval(storeId: string, cartId: string, token: string): Promise<boolean> {
	if (!CART_ID_PATTERN.test(cartId)) return false;
	const m = await repo.getMerchant(storeId);
	const row = m && (await repo.getCartRow(m.id, cartId));
	if (!m || !row || row.paypalOrderId !== token || row.status === "COMPLETED") return false;
	const order = await paypal.getOrder(repo.credsFor(m), token);
	const payerId = order.status === "APPROVED" ? order.payer?.payerId : undefined;
	if (!payerId) return false;
	await db()
		.update(carts)
		.set({ payerId, updatedAt: new Date() })
		.where(and(eq(carts.id, cartId), eq(carts.paypalOrderId, token)));
	return true;
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
			// A fresh id per attempt: a retried PUT may carry a different cart and must not
			// get the earlier attempt's order back. (The SDK's own retries reuse it.)
			requestId: randomUUID(),
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

/**
 * The response body. Validated against the spec schema so we never emit a non-conformant cart.
 * A checkout-ready cart is CREATED in the create response and READY afterwards (as in the spec).
 */
function cartBody(id: string, ev: Evaluation, pay?: PaymentState, readyStatus?: "READY"): PayPalCart {
	return PayPalCart.parse({
		id,
		...ev.cart,
		...(ev.valid && readyStatus && { status: readyStatus }),
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
