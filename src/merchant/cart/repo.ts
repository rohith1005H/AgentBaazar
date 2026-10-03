/** Database access for the cart service. Everything merchant-scoped. */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { CheckoutFieldType } from "@/src/cart-spec/schema";
import { decrypt } from "@/src/crypto";
import { db, type Tx } from "@/src/db/client";
import { carts, coupons, merchants, orderNumberSeq, products, variants } from "@/src/db/schema";
import { envCreds, type PayPalCreds } from "@/src/merchant/paypal/http";
import type { Availability, CatalogVariant, CouponRow } from "./types";

export type Merchant = typeof merchants.$inferSelect;
export type CartRow = typeof carts.$inferSelect;

export async function getMerchant(id: string): Promise<Merchant | undefined> {
	const [m] = await db().select().from(merchants).where(eq(merchants.id, id));
	return m;
}

/** Per-merchant PayPal credentials when configured, else the deployment default. */
export function credsFor(m: Merchant): PayPalCreds {
	if (m.paypalClientId && m.paypalClientSecretEnc) {
		return { clientId: m.paypalClientId, clientSecret: decrypt(m.paypalClientSecretEnc) };
	}
	return envCreds();
}

/** The requested variants plus every sibling variant of the same products (for alternatives). */
export async function loadCatalog(merchantId: string, variantIds: string[]): Promise<Map<string, CatalogVariant>> {
	if (variantIds.length === 0) return new Map();
	const productIds = db().select({ id: variants.productId }).from(variants).where(inArray(variants.id, variantIds));
	const rows = await db()
		.select({ v: variants, p: products })
		.from(variants)
		.innerJoin(products, eq(variants.productId, products.id))
		.where(and(eq(products.merchantId, merchantId), inArray(variants.productId, productIds)));
	return new Map(rows.map(({ v, p }) => [v.id, toCatalogVariant(v, p)]));
}

export function toCatalogVariant(v: typeof variants.$inferSelect, p: typeof products.$inferSelect): CatalogVariant {
	return {
		id: v.id,
		productId: p.id,
		groupId: p.groupId,
		title: v.title,
		description: p.description,
		url: v.url ?? p.url,
		priceCents: v.priceCents,
		salePriceCents: v.salePriceCents,
		currency: v.currency,
		color: v.color,
		size: v.size,
		weightG: v.weightG,
		availability: v.availability as Availability,
		stockQty: v.stockQty,
		restockEta: v.restockEta,
		fragile: p.flags?.fragile ?? false,
		requiresFields: (p.flags?.requiresFields ?? []) as CheckoutFieldType[],
		agentCheckout: p.flags?.eligibleCheckout ?? true,
	};
}

export async function loadCoupons(merchantId: string, codes: string[]): Promise<Map<string, CouponRow>> {
	const upper = [...new Set(codes.map((c) => c.toUpperCase()))];
	if (upper.length === 0) return new Map();
	const rows = await db()
		.select()
		.from(coupons)
		.where(and(eq(coupons.merchantId, merchantId), inArray(coupons.code, upper)));
	return new Map(
		rows.map((r) => [
			r.code,
			{
				code: r.code,
				kind: r.kind as CouponRow["kind"],
				value: r.value,
				minSubtotalCents: r.minSubtotalCents,
				maxUses: r.maxUses,
				used: r.used,
				expiresAt: r.expiresAt,
				issuedToCartId: r.issuedToCartId,
				description: r.description,
			},
		]),
	);
}

export async function getCartRow(merchantId: string, cartId: string): Promise<CartRow | undefined> {
	const [row] = await db()
		.select()
		.from(carts)
		.where(and(eq(carts.id, cartId), eq(carts.merchantId, merchantId)));
	return row;
}

/** Writes only if nobody else changed the cart since we read `version`. Returns false on conflict. */
export async function updateCartIfVersion(
	tx: Tx,
	cartId: string,
	version: number,
	set: Partial<typeof carts.$inferInsert>,
): Promise<boolean> {
	const updated = await tx
		.update(carts)
		.set({ ...set, version: version + 1, updatedAt: new Date() })
		.where(and(eq(carts.id, cartId), eq(carts.version, version)))
		.returning({ id: carts.id });
	return updated.length === 1;
}

export async function nextOrderNumber(tx: Tx): Promise<string> {
	const r = await tx.execute<{ n: string }>(
		sql`select nextval(${sql.raw(`'merchant.${orderNumberSeq.seqName}'`)}) as n`,
	);
	return `AB-${r.rows[0].n}`;
}

/** Decrement stock iff enough is left. Returns false when another order got there first. */
export async function reserveStock(tx: Tx, variantId: string, qty: number): Promise<boolean> {
	const r = await tx
		.update(variants)
		.set({ stockQty: sql`${variants.stockQty} - ${qty}` })
		.where(and(eq(variants.id, variantId), sql`${variants.stockQty} >= ${qty}`))
		.returning({ id: variants.id });
	return r.length === 1;
}

export async function releaseStock(tx: Tx, variantId: string, qty: number): Promise<void> {
	await tx
		.update(variants)
		.set({ stockQty: sql`${variants.stockQty} + ${qty}` })
		.where(eq(variants.id, variantId));
}

/** Count a coupon use iff it still has uses left. */
export async function consumeCoupon(tx: Tx, merchantId: string, code: string): Promise<boolean> {
	const r = await tx
		.update(coupons)
		.set({ used: sql`${coupons.used} + 1` })
		.where(and(eq(coupons.merchantId, merchantId), eq(coupons.code, code), sql`${coupons.used} < ${coupons.maxUses}`))
		.returning({ code: coupons.code });
	return r.length === 1;
}

export async function releaseCoupon(tx: Tx, merchantId: string, code: string): Promise<void> {
	await tx
		.update(coupons)
		.set({ used: sql`greatest(${coupons.used} - 1, 0)` })
		.where(and(eq(coupons.merchantId, merchantId), eq(coupons.code, code)));
}
