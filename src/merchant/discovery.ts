/**
 * Agent-facing discovery and offers. These are AgentBaazar extensions outside
 * the Cart API spec: under Store Sync, discovery happens on PayPal's side from
 * the ingested feed. A store we host needs to answer it itself.
 */
import { randomInt } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { z } from "zod";
import type { CartRequest, PayPalCart } from "@/src/cart-spec/schema";
import { db } from "@/src/db/client";
import { cartEvents, coupons, orders, products, variants } from "@/src/db/schema";
import { type ApiResult, badRequest, notFound, unprocessable } from "./api/http";
import type { CartCaller } from "./auth/jwt-verify";
import { toCents, toMoney, usd } from "./cart/money";
import * as repo from "./cart/repo";

// ---------------------------------------------------------------- search

const STOP = new Set([
	"a",
	"an",
	"the",
	"for",
	"and",
	"or",
	"of",
	"to",
	"in",
	"with",
	"under",
	"below",
	"me",
	"my",
	"some",
	"find",
	"buy",
	"want",
	"need",
	"i",
]);

/**
 * Keyword search over the store's own catalog.
 * ponytail: scores products in memory, fine for small-merchant catalogs (hundreds of SKUs);
 * move to Postgres full-text (tsvector) when a store has thousands.
 */
export async function searchCatalog(store: string, params: URLSearchParams): Promise<ApiResult> {
	const m = await repo.getMerchant(store);
	if (!m) throw notFound("STORE_NOT_FOUND", `Store '${store}' does not exist`);
	const rawMax = params.get("max_price");
	if (rawMax !== null && !/^\d+(\.\d{1,2})?$/.test(rawMax))
		throw badRequest("max_price must be a decimal amount like 40.00", "max_price", "INVALID_FORMAT");
	const tokens = (params.get("q") ?? "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length > 1 && !STOP.has(t));
	const maxPrice = rawMax ? toCents(rawMax) : undefined;
	const limit = Math.min(Number(params.get("limit") ?? 10) || 10, 25);

	const rows = await db()
		.select({ v: variants, p: products })
		.from(variants)
		.innerJoin(products, eq(variants.productId, products.id))
		.where(eq(products.merchantId, m.id));

	const byProduct = new Map<string, { p: (typeof rows)[number]["p"]; vs: (typeof rows)[number]["v"][] }>();
	for (const { v, p } of rows) {
		if (p.flags?.eligibleSearch === false) continue;
		const e = byProduct.get(p.id) ?? { p, vs: [] };
		e.vs.push(v);
		byProduct.set(p.id, e);
	}

	const unit = (v: (typeof rows)[number]["v"]) => v.salePriceCents ?? v.priceCents;
	const scored = [...byProduct.values()]
		.map(({ p, vs }) => {
			const affordable = maxPrice === undefined ? vs : vs.filter((v) => unit(v) <= maxPrice);
			const title = p.title.toLowerCase();
			const body = `${p.description ?? ""} ${p.category ?? ""} ${p.brand ?? ""}`.toLowerCase();
			const attrs = vs.map((v) => `${v.color ?? ""} ${v.size ?? ""} ${v.title}`.toLowerCase()).join(" ");
			const score = tokens.reduce(
				(s, t) => s + (title.includes(t) ? 3 : 0) + (body.includes(t) ? 1 : 0) + (attrs.includes(t) ? 1 : 0),
				0,
			);
			const inStock = affordable.some((v) => v.availability === "in_stock" && v.stockQty > 0);
			return { p, vs: affordable, score, inStock };
		})
		.filter((x) => x.vs.length > 0 && (tokens.length === 0 || x.score > 0))
		.sort((a, b) => b.score - a.score || Number(b.inStock) - Number(a.inStock))
		.slice(0, limit);

	return {
		status: 200,
		body: {
			store: { id: m.id, name: m.name },
			products: scored.map(({ p, vs }) => ({
				product_id: p.id,
				title: p.title,
				description: p.description,
				url: p.url,
				image_url: p.imageUrl,
				agent_checkout: p.flags?.eligibleCheckout !== false,
				variants: vs
					.sort((a, b) => Number(b.stockQty > 0) - Number(a.stockQty > 0) || a.id.localeCompare(b.id))
					.map((v) => ({
						variant_id: v.id,
						title: v.title,
						price: toMoney(unit(v), v.currency),
						...(v.salePriceCents !== null && { list_price: toMoney(v.priceCents, v.currency) }),
						availability: v.availability,
						in_stock_quantity: v.stockQty,
						...(v.restockEta && { availability_date: v.restockEta }),
						color: v.color,
						size: v.size,
					})),
			})),
		},
	};
}

// ---------------------------------------------------------------- offers

const OfferRequest = z.object({ cart_id: z.string(), reason: z.string().max(200).optional() });

/**
 * Bounded negotiation: the merchant's policy, not an LLM, decides what an agent
 * can get. The best single applicable offer is minted as a one-time coupon bound
 * to this cart; asking again returns the same coupon.
 */
export async function makeOffer(m: repo.Merchant, body: unknown, caller: CartCaller): Promise<ApiResult> {
	const { cart_id, reason } = OfferRequest.parse(body);
	const row = await repo.getCartRow(m.id, cart_id);
	if (!row || (row.jwtSub && row.jwtSub !== caller.subject))
		throw notFound("CART_NOT_FOUND", `Cart with ID '${cart_id}' does not exist`);
	if (row.status === "COMPLETED") throw unprocessable("Cart is already checked out");

	const now = new Date();
	const [existing] = await db()
		.select()
		.from(coupons)
		.where(
			and(
				eq(coupons.merchantId, m.id),
				eq(coupons.issuedToCartId, cart_id),
				lt(coupons.used, coupons.maxUses),
				gt(coupons.expiresAt, now),
			),
		)
		.limit(1);
	if (existing)
		return {
			status: 200,
			body: { offer: offerBody(existing.code, existing.description ?? "", existing.value, existing.expiresAt!) },
		};

	const policy = m.policy.coupons;
	const cart = row.payload as PayPalCart;
	const subtotal = toCents(cart.totals?.subtotal?.value ?? "0");
	if (subtotal < policy.minSubtotalCents)
		return { status: 200, body: { offer: null, reason: `Offers start at a ${usd(policy.minSubtotalCents)} subtotal` } };

	const email = (row.request as CartRequest).customer?.email_address;
	const firstOrder = email ? !(await hasOrdered(m.id, email)) : false;
	const quantity = (cart.items ?? []).reduce((s, i) => s + i.quantity, 0);
	const candidates = [
		...(firstOrder
			? [{ prefix: "WELCOME", pct: policy.firstOrderPct, description: `${policy.firstOrderPct}% off your first order` }]
			: []),
		...(policy.bundle && quantity >= policy.bundle.minItems
			? [
					{
						prefix: "BUNDLE",
						pct: policy.bundle.pct,
						description: `${policy.bundle.pct}% off ${policy.bundle.minItems}+ items`,
					},
				]
			: []),
	].filter((c) => c.pct > 0);
	if (candidates.length === 0) {
		const hint = email ? "" : " (a first-order offer needs the buyer's email on the cart)";
		return { status: 200, body: { offer: null, reason: `No offer applies to this cart${hint}` } };
	}

	const best = candidates.reduce((a, b) => (b.pct > a.pct ? b : a));
	const pct = Math.min(best.pct, policy.maxTotalPct);
	const code = `${best.prefix}${pct}-${randomCode()}`;
	const expiresAt = new Date(now.getTime() + policy.expiresMinutes * 60_000);
	await db().transaction(async (tx) => {
		await tx.insert(coupons).values({
			code,
			merchantId: m.id,
			kind: "percent",
			value: pct,
			minSubtotalCents: policy.minSubtotalCents,
			maxUses: 1,
			expiresAt,
			issuedToCartId: cart_id,
			description: best.description,
		});
		await tx
			.insert(cartEvents)
			.values({ id: ulid(), cartId: cart_id, kind: "offer", data: { code, pct, reason: reason ?? null } });
	});
	return { status: 200, body: { offer: offerBody(code, best.description, pct, expiresAt) } };
}

const offerBody = (code: string, description: string, pct: number, expiresAt: Date) => ({
	code,
	description,
	percent_off: pct,
	expires_at: expiresAt.toISOString(),
	// how to use it: PUT the cart with coupons: [{ code, action: "APPLY" }]
	apply: { coupons: [{ code, action: "APPLY" }] },
});

async function hasOrdered(merchantId: string, email: string): Promise<boolean> {
	const [r] = await db()
		.select({ n: sql<number>`count(*)::int` })
		.from(orders)
		.where(
			and(eq(orders.merchantId, merchantId), sql`lower(${orders.buyer}->>'email_address') = ${email.toLowerCase()}`),
		);
	return (r?.n ?? 0) > 0;
}

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const randomCode = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
