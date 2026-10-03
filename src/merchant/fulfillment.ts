/**
 * Post-checkout operations on an order, driven by the merchant (console, ops agent):
 *
 *   ship    AUTHORIZED -> capture the authorization, post tracking to PayPal -> CAPTURED
 *   cancel  AUTHORIZED -> void the authorization, return stock               -> VOIDED
 *   refund  CAPTURED   -> refund all or part of the capture                   -> (PARTIALLY_)REFUNDED
 *
 * Capture-on-ship is the core buyer protection for agent purchases: the buyer
 * is charged only once the merchant commits to fulfil.
 */
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/src/db/client";
import { orderItems, orders, refunds, shipments } from "@/src/db/schema";
import { publish } from "@/src/events/bus";
import { log } from "@/src/log";
import { type ApiResult, notFound, unprocessable } from "./api/http";
import { toCents, toMoney } from "./cart/money";
import * as repo from "./cart/repo";
import { PayPalError } from "./paypal/http";
import * as paypal from "./paypal/orders";

type OrderRow = typeof orders.$inferSelect;

async function load(store: string, orderId: string) {
	const m = await repo.getMerchant(store);
	if (!m) throw notFound("STORE_NOT_FOUND", `Store '${store}' does not exist`);
	const [o] = await db()
		.select()
		.from(orders)
		.where(and(eq(orders.id, orderId), eq(orders.merchantId, m.id)));
	if (!o) throw notFound("ORDER_NOT_FOUND", `Order '${orderId}' does not exist`);
	return { m, o, creds: repo.credsFor(m) };
}

/** What an agent may see about an order it placed. */
export async function orderStatus(store: string, orderId: string): Promise<ApiResult> {
	const { o } = await load(store, orderId);
	const ships = await db().select().from(shipments).where(eq(shipments.orderId, o.id));
	return {
		status: 200,
		body: {
			order_id: o.id,
			status: o.status,
			total: toMoney(o.totalCents),
			created_at: o.createdAt.toISOString(),
			shipments: ships.map((s) => ({
				carrier: s.carrier,
				tracking_number: s.trackingNumber,
				shipped_at: s.shippedAt.toISOString(),
			})),
		},
	};
}

const ShipBody = z.object({ carrier: z.string().min(2).max(40), tracking_number: z.string().min(4).max(64) });

export async function shipOrder(store: string, orderId: string, body: unknown): Promise<ApiResult> {
	const { carrier, tracking_number } = ShipBody.parse(body);
	const { m, o, creds } = await load(store, orderId);
	if (o.status !== "AUTHORIZED" && o.status !== "CAPTURED")
		throw unprocessable(`Order is ${o.status}; only authorized or captured orders can ship`);

	let captureId = o.captureId;
	if (o.status === "AUTHORIZED") {
		if (!o.authorizationId) throw unprocessable("Order has no authorization to capture");
		const cap = await paypal.captureAuthorization(creds, o.authorizationId, `${o.id}-capture`, {
			invoiceId: o.id,
			final: true,
		});
		captureId = cap.captureId;
		await db().update(orders).set({ status: "CAPTURED", captureId, capturedAt: new Date() }).where(eq(orders.id, o.id));
	}

	// Tracking is best-effort: the money has moved, so a tracking failure must not undo the ship.
	let trackerId: string | undefined;
	try {
		trackerId = await paypal.addTracking(creds, o.paypalOrderId, {
			captureId: captureId!,
			carrier,
			trackingNumber: tracking_number,
		});
	} catch (e) {
		log.warn(
			{ order: o.id, err: e instanceof PayPalError ? { name: e.name, debugId: e.debugId } : String(e) },
			"tracking not posted",
		);
	}
	await db()
		.insert(shipments)
		.values({
			id: randomUUID(),
			orderId: o.id,
			carrier,
			trackingNumber: tracking_number,
			paypalTrackerId: trackerId ?? null,
		});

	publish({ type: "order", store: m.id, orderId: o.id, status: "CAPTURED", totalCents: o.totalCents });
	return {
		status: 200,
		body: {
			order_id: o.id,
			status: "CAPTURED",
			capture_id: captureId,
			tracking_posted: Boolean(trackerId),
			paypal_tracker_id: trackerId,
		},
	};
}

export async function cancelOrder(store: string, orderId: string): Promise<ApiResult> {
	const { m, o, creds } = await load(store, orderId);
	if (o.status !== "AUTHORIZED")
		throw unprocessable(`Order is ${o.status}; only an uncaptured authorization can be voided`);
	await paypal.voidAuthorization(creds, o.authorizationId!);
	await db().transaction(async (tx) => {
		const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
		for (const i of items) if (i.stockReserved) await repo.releaseStock(tx, i.variantId, i.qty);
		await tx.update(orders).set({ status: "VOIDED" }).where(eq(orders.id, o.id));
	});
	publish({ type: "order", store: m.id, orderId: o.id, status: "VOIDED", totalCents: o.totalCents });
	return { status: 200, body: { order_id: o.id, status: "VOIDED" } };
}

const RefundBody = z.object({
	amount: z.object({ currency_code: z.literal("USD"), value: z.string() }).optional(),
	reason: z.string().max(255).optional(),
	/** Send the same id when retrying so PayPal does not refund twice */
	request_id: z.string().max(100).optional(),
});

export async function refundOrder(store: string, orderId: string, body: unknown): Promise<ApiResult> {
	const req = RefundBody.parse(body ?? {});
	const { m, o, creds } = await load(store, orderId);
	if (o.status !== "CAPTURED" && o.status !== "PARTIALLY_REFUNDED")
		throw unprocessable(`Order is ${o.status}; only captured orders can be refunded`);

	const [{ refunded }] = await db()
		.select({ refunded: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
		.from(refunds)
		.where(eq(refunds.orderId, o.id));
	const remaining = o.totalCents - refunded;
	const amount = req.amount ? toCents(req.amount.value) : remaining;
	if (amount <= 0 || amount > remaining)
		throw unprocessable(`Refund must be between 0.01 and ${(remaining / 100).toFixed(2)}`);

	const r = await paypal.refundCapture(creds, o.captureId!, req.request_id ?? randomUUID(), {
		amountCents: amount,
		note: req.reason,
	});
	const status = amount === remaining ? "REFUNDED" : "PARTIALLY_REFUNDED";
	await db().transaction(async (tx) => {
		await tx
			.insert(refunds)
			.values({
				id: r.refundId,
				orderId: o.id,
				captureId: o.captureId!,
				paypalRefundId: r.refundId,
				amountCents: amount,
				reason: req.reason,
			})
			.onConflictDoNothing();
		await tx.update(orders).set({ status }).where(eq(orders.id, o.id));
	});
	publish({ type: "order", store: m.id, orderId: o.id, status, totalCents: o.totalCents });
	return { status: 200, body: { order_id: o.id, status, refund_id: r.refundId, refunded: toMoney(amount) } };
}

export type { OrderRow };
