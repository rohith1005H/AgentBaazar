/**
 * What the console shows, read from the merchant tables and shaped for AG Studio:
 * money in dollars, ISO timestamps, one row per thing, plus two derived tables:
 *   cart_stages  one row per stage a cart reached (so counting carts per stage is a funnel)
 *   cart_issues  one row per distinct problem a store flagged on a cart
 */
import { desc, inArray } from "drizzle-orm";
import type { PayPalCart } from "@/src/cart-spec/schema";
import { db } from "@/src/db/client";
import { cartEvents, carts, merchants, orders } from "@/src/db/schema";
import { toCents } from "@/src/merchant/cart/money";

type Row = Record<string, string | number | null>;
export type ConsoleData = { orders: Row[]; carts: Row[]; cart_stages: Row[]; cart_issues: Row[] };

export const STAGES = ["Cart opened", "Ready to pay", "Approved in PayPal", "Payment authorized", "Captured on ship"];
const PAID = new Set([
	"AUTHORIZED",
	"PAYMENT_PENDING",
	"CAPTURED",
	"CAPTURE_PENDING",
	"PARTIALLY_REFUNDED",
	"REFUNDED",
	"DISPUTED",
]);

const dollars = (cents: number | null) => (cents === null ? null : cents / 100);

export async function consoleData(): Promise<ConsoleData> {
	const [stores, orderRows, cartRows] = await Promise.all([
		db().select({ id: merchants.id, name: merchants.name }).from(merchants),
		db().select().from(orders).orderBy(desc(orders.createdAt)).limit(500),
		// ponytail: the 500 most recent carts; page through Studio's async sources if stores grow
		db().select().from(carts).orderBy(desc(carts.createdAt)).limit(500),
	]);
	const storeName = new Map(stores.map((s) => [s.id, s.name]));
	const events = cartRows.length
		? await db()
				.select({ cartId: cartEvents.cartId, data: cartEvents.data })
				.from(cartEvents)
				.where(
					inArray(
						cartEvents.cartId,
						cartRows.map((c) => c.id),
					),
				)
		: [];
	const orderByCart = new Map(orderRows.map((o) => [o.cartId, o]));
	const now = Date.now();

	const issues = new Map<string, Set<string>>();
	for (const e of events)
		for (const code of ((e.data as { issues?: string[] } | null)?.issues ?? []) as string[])
			issues.set(e.cartId, (issues.get(e.cartId) ?? new Set()).add(code));

	return {
		orders: orderRows.map((o) => ({
			id: o.id,
			store_id: o.merchantId, // not a Studio field: lets the console's actions address the order
			cart_id: o.cartId,
			store: storeName.get(o.merchantId) ?? o.merchantId,
			status: o.status,
			total: dollars(o.totalCents),
			coupon: o.couponCodes?.[0]?.replace(/-[A-Z0-9]+$/, "") ?? null,
			awaiting_ship: o.status === "AUTHORIZED" ? 1 : 0,
			auth_age_hours:
				o.status === "AUTHORIZED" ? Math.round(((now - o.createdAt.getTime()) / 3_600_000) * 10) / 10 : null,
			created_at: o.createdAt.toISOString(),
			captured_at: o.capturedAt?.toISOString() ?? null,
			ship: o.status === "AUTHORIZED" ? `${o.merchantId}/${o.id}` : null,
		})),
		carts: cartRows.map((c) => ({
			id: c.id,
			store: storeName.get(c.merchantId) ?? c.merchantId,
			status: c.status,
			total: (c.payload as PayPalCart).totals?.total
				? toCents((c.payload as PayPalCart).totals!.total.value) / 100
				: null,
			created_at: c.createdAt.toISOString(),
		})),
		cart_stages: cartRows.flatMap((c) => {
			const o = orderByCart.get(c.id);
			const reached = [
				true,
				c.validationStatus === "VALID" || c.status === "COMPLETED",
				Boolean(c.payerId) || c.status === "COMPLETED",
				Boolean(o && PAID.has(o.status)),
				Boolean(o?.captureId),
			];
			const store = storeName.get(c.merchantId) ?? c.merchantId;
			return STAGES.flatMap((stage, i) => (reached[i] ? [{ cart_id: c.id, store, stage, stage_rank: i + 1 }] : []));
		}),
		cart_issues: cartRows.flatMap((c) =>
			[...(issues.get(c.id) ?? [])].map((issue) => ({
				cart_id: c.id,
				store: storeName.get(c.merchantId) ?? c.merchantId,
				issue: issue.toLowerCase().replaceAll("_", " "),
			})),
		),
	};
}
