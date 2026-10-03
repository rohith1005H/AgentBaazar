/**
 * PayPal webhook listener. Webhooks tell us about things our own API calls did
 * not cause: a buyer approving in PayPal, a capture or refund made from the
 * PayPal dashboard, an authorization expiring or being voided, a dispute.
 *
 *   1. verify the signature (see webhook-verify.ts); unverified events are rejected
 *   2. store the event, keyed by PayPal's event id, so redeliveries are no-ops
 *   3. reconcile our order/cart/dispute rows, using conditional updates so an
 *      event that echoes our own action (we voided, then VOIDED arrives) changes nothing
 *
 * PayPal retries non-2xx deliveries for 3 days, so anything we cannot match
 * (e.g. an event for a store order created elsewhere) is acknowledged and kept.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/src/db/client";
import { carts, disputes, orderItems, orders, refunds, webhookEvents } from "@/src/db/schema";
import { publish } from "@/src/events/bus";
import { log } from "@/src/log";
import { type ApiResult, HttpError } from "./api/http";
import { toCents } from "./cart/money";
import { releaseStock } from "./cart/repo";
import { readWebhookHeaders, verifyWebhookSignature } from "./paypal/webhook-verify";

type Money = { currency_code?: string; value?: string };
type Resource = {
	id?: string;
	status?: string;
	amount?: Money;
	payer?: { payer_id?: string };
	supplementary_data?: { related_ids?: { order_id?: string; authorization_id?: string; capture_id?: string } };
	links?: { rel?: string; href?: string }[];
	// disputes
	dispute_id?: string;
	reason?: string;
	dispute_life_cycle_stage?: string;
	dispute_amount?: Money;
	seller_response_due_date?: string;
	disputed_transactions?: { seller_transaction_id?: string }[];
};
type WebhookEvent = { id: string; event_type: string; resource_type?: string; resource: Resource };

export async function handleWebhook(req: Request): Promise<ApiResult> {
	const raw = await req.text();
	let event: WebhookEvent;
	try {
		event = JSON.parse(raw);
	} catch {
		throw new HttpError(400, { name: "MALFORMED_REQUEST", message: "Body is not JSON" });
	}
	if (!event?.id || !event.event_type)
		throw new HttpError(400, { name: "MALFORMED_REQUEST", message: "Not a PayPal event" });

	const verified = await verify(req.headers, raw);
	if (!verified) {
		log.warn({ event: event.id, type: event.event_type }, "webhook signature rejected");
		throw new HttpError(401, { name: "INVALID_SIGNATURE", message: "Webhook signature verification failed" });
	}

	const inserted = await db()
		.insert(webhookEvents)
		.values({
			id: event.id,
			eventType: event.event_type,
			resourceType: event.resource_type,
			resourceId: event.resource?.id ?? event.resource?.dispute_id,
			verified: true,
			raw: event as unknown as Record<string, unknown>,
		})
		.onConflictDoNothing()
		.returning({ id: webhookEvents.id });
	if (inserted.length === 0) return { status: 200, body: { received: true, duplicate: true } };

	const store = await reconcile(event);
	await db()
		.update(webhookEvents)
		.set({ processedAt: new Date(), merchantId: store ?? null })
		.where(eq(webhookEvents.id, event.id));
	if (store) publish({ type: "webhook", store, eventType: event.event_type, resourceId: event.resource?.id });
	log.info({ event: event.id, type: event.event_type, store }, "webhook processed");
	return { status: 200, body: { received: true } };
}

async function verify(headers: Headers, raw: string): Promise<boolean> {
	if (process.env.WEBHOOK_VERIFY === "skip") {
		log.warn("WEBHOOK_VERIFY=skip: accepting an unverified webhook (development only)");
		return true;
	}
	const webhookId = process.env.PAYPAL_WEBHOOK_ID;
	const h = readWebhookHeaders(headers);
	if (!webhookId || !h) return false;
	try {
		if (await verifyWebhookSignature(h, raw, webhookId)) return true;
		// PayPal signs simulator events with the literal webhook id "WEBHOOK_ID". Anyone with a
		// PayPal developer account can aim the simulator at our URL, so this is opt-in for local testing only.
		return process.env.WEBHOOK_ACCEPT_SIMULATOR === "true" && (await verifyWebhookSignature(h, raw, "WEBHOOK_ID"));
	} catch (e) {
		log.warn({ err: String(e) }, "webhook verification error");
		return false;
	}
}

/** Applies the event; returns the store it belonged to, if we could match it. */
async function reconcile(e: WebhookEvent): Promise<string | undefined> {
	const r = e.resource ?? {};
	const orderId = r.supplementary_data?.related_ids?.order_id;

	switch (e.event_type) {
		case "CHECKOUT.ORDER.APPROVED": {
			// The buyer approved in PayPal; record who, so the cart shows it before checkout.
			const [c] = await db()
				.update(carts)
				.set({ payerId: r.payer?.payer_id ?? null, updatedAt: new Date() })
				.where(eq(carts.paypalOrderId, r.id ?? ""))
				.returning({ store: carts.merchantId });
			return c?.store;
		}
		case "PAYMENT.AUTHORIZATION.CREATED": {
			// Finalizes an authorization PayPal first reported as PENDING.
			const [o] = await db()
				.update(orders)
				.set({ status: "AUTHORIZED", authorizationId: r.id })
				.where(and(eq(orders.paypalOrderId, orderId ?? ""), eq(orders.status, "PAYMENT_PENDING")))
				.returning({ store: orders.merchantId });
			return o?.store ?? storeOfPayPalOrder(orderId);
		}
		case "PAYMENT.AUTHORIZATION.VOIDED": {
			// Voided outside our cancel flow (dashboard, or the authorization expired): put stock back once.
			return db().transaction(async (tx) => {
				const [o] = await tx
					.update(orders)
					.set({ status: "VOIDED" })
					.where(and(eq(orders.paypalOrderId, orderId ?? ""), eq(orders.status, "AUTHORIZED")))
					.returning();
				if (!o) return storeOfPayPalOrder(orderId);
				const items = await tx.select().from(orderItems).where(eq(orderItems.orderId, o.id));
				for (const i of items) if (i.stockReserved) await releaseStock(tx, i.variantId, i.qty);
				return o.merchantId;
			});
		}
		case "PAYMENT.CAPTURE.COMPLETED": {
			// Captured outside our ship flow (e.g. from the PayPal dashboard).
			const [o] = await db()
				.update(orders)
				.set({ status: "CAPTURED", captureId: r.id, capturedAt: new Date() })
				.where(
					and(
						eq(orders.paypalOrderId, orderId ?? ""),
						inArray(orders.status, ["PENDING", "AUTHORIZED", "CAPTURE_PENDING"]),
					),
				)
				.returning({ store: orders.merchantId });
			return o?.store ?? storeOfPayPalOrder(orderId);
		}
		case "PAYMENT.CAPTURE.DENIED":
		case "PAYMENT.CAPTURE.DECLINED":
		case "PAYMENT.CAPTURE.REVERSED": {
			const status = e.event_type.endsWith("REVERSED") ? "REVERSED" : "FAILED";
			const [o] = await db()
				.update(orders)
				.set({ status })
				.where(eq(orders.paypalOrderId, orderId ?? ""))
				.returning({ store: orders.merchantId });
			return o?.store;
		}
		case "PAYMENT.CAPTURE.REFUNDED": {
			// Resource is the refund; its "up" link points at the capture.
			const captureId = r.links
				?.find((l) => l.rel === "up")
				?.href?.split("/")
				.pop();
			const [o] = await db()
				.select()
				.from(orders)
				.where(eq(orders.captureId, captureId ?? ""));
			if (!o || !r.id) return undefined;
			await db().transaction(async (tx) => {
				await tx
					.insert(refunds)
					.values({
						id: r.id!,
						orderId: o.id,
						captureId: o.captureId!,
						paypalRefundId: r.id!,
						amountCents: toCents(r.amount?.value ?? "0"),
						reason: "refunded in PayPal",
					})
					.onConflictDoNothing();
				const [{ total }] = await tx
					.select({ total: sql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
					.from(refunds)
					.where(eq(refunds.orderId, o.id));
				await tx
					.update(orders)
					.set({ status: total >= o.totalCents ? "REFUNDED" : "PARTIALLY_REFUNDED" })
					.where(eq(orders.id, o.id));
			});
			return o.merchantId;
		}
		case "CUSTOMER.DISPUTE.CREATED":
		case "CUSTOMER.DISPUTE.UPDATED":
		case "CUSTOMER.DISPUTE.RESOLVED": {
			const captureId = r.disputed_transactions?.[0]?.seller_transaction_id;
			const [o] = captureId ? await db().select().from(orders).where(eq(orders.captureId, captureId)) : [];
			if (!o || !r.dispute_id) return undefined;
			const row = {
				orderId: o.id,
				merchantId: o.merchantId,
				reason: r.reason,
				status: r.status,
				stage: r.dispute_life_cycle_stage,
				amountCents: r.dispute_amount?.value ? toCents(r.dispute_amount.value) : null,
				respondBy: r.seller_response_due_date ? new Date(r.seller_response_due_date) : null,
				raw: r as Record<string, unknown>,
				updatedAt: new Date(),
			};
			await db()
				.insert(disputes)
				.values({ id: r.dispute_id, ...row })
				.onConflictDoUpdate({ target: disputes.id, set: row });
			if (e.event_type === "CUSTOMER.DISPUTE.CREATED")
				await db().update(orders).set({ status: "DISPUTED" }).where(eq(orders.id, o.id));
			return o.merchantId;
		}
		default:
			// CHECKOUT.ORDER.COMPLETED, PAYMENT.CAPTURE.PENDING:
			// already reflected by our own API calls; stored for the audit trail.
			return storeOfPayPalOrder(orderId ?? r.id);
	}
}

async function storeOfPayPalOrder(paypalOrderId: string | undefined): Promise<string | undefined> {
	if (!paypalOrderId) return undefined;
	const [c] = await db()
		.select({ store: carts.merchantId })
		.from(carts)
		.where(eq(carts.paypalOrderId, paypalOrderId))
		.limit(1);
	return c?.store;
}
