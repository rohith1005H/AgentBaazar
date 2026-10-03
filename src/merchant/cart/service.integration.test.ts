/**
 * Cart service against a real Postgres (a Neon branch, TEST_DATABASE_URL) with an
 * in-memory PayPal. Covers the money-moving paths: checkout, idempotent replay,
 * declines, PayPal answers that do not match what we expected, lost responses,
 * and a cart edited while it is being paid for.
 *
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PayPalCart } from "@/src/cart-spec/schema";
import { HttpError } from "@/src/merchant/api/http";
import type { CartCaller } from "@/src/merchant/auth/jwt-verify";

vi.mock("@/src/merchant/paypal/orders", async () => await import("@/src/test/fake-paypal"));

const TEST_DB = process.env.TEST_DATABASE_URL;
const M = `it-${Date.now().toString(36)}`;
const BLUE = `${M}-blue-m`;
const INDIGO = `${M}-indigo-m`;
const BEANS = `${M}-beans`;

const caller: CartCaller = {
	payload: { iss: "https://platform.test", sub: "https://platform.test", merchant_id: M },
	merchantId: M,
	subject: "https://platform.test",
};
const stranger: CartCaller = {
	...caller,
	subject: "https://someone-else.test",
	payload: { ...caller.payload, sub: "x" },
};

const buyer = {
	customer: { name: { given_name: "Rohan", surname: "Mehta" }, email_address: "rohan@example.com" },
	shipping_address: {
		address_line_1: "100 Congress Ave",
		admin_area_2: "Austin",
		admin_area_1: "TX",
		postal_code: "78701",
		country_code: "US",
	},
};

describe.skipIf(!TEST_DB)("cart service (Postgres + fake PayPal)", async () => {
	process.env.DATABASE_URL = TEST_DB;
	process.env.PAYPAL_CLIENT_ID = "test-client";
	process.env.PAYPAL_CLIENT_SECRET = "test-secret";
	process.env.APP_SECRET = "a".repeat(64);
	process.env.PUBLIC_URL = "https://shop.test";
	process.env.CHECKOUT_STALE_MS = "0";
	process.env.LOG_LEVEL = "silent";

	const { fake } = await import("@/src/test/fake-paypal");
	const { closeDb, db } = await import("@/src/db/client");
	const s = await import("@/src/db/schema");
	const { importFeed } = await import("@/src/merchant/catalog/import");
	const svc = await import("./service");
	const repo = await import("./repo");

	const merchant = () => repo.getMerchant(M).then((m) => m!);
	const stock = async (id: string) => (await db().select().from(s.variants).where(eq(s.variants.id, id)))[0].stockQty;
	const ordersFor = (token: string) => db().select().from(s.orders).where(eq(s.orders.paypalOrderId, token));

	async function readyCart(
		items = [{ variant_id: INDIGO, quantity: 2 }],
		coupons?: { code: string; action: "APPLY" }[],
	) {
		const r = await svc.createCart(await merchant(), { items, ...buyer, ...(coupons && { coupons }) }, caller);
		const cart = r.body as PayPalCart;
		expect(cart.validation_status).toBe("VALID");
		return { cart, token: cart.payment_method!.token! };
	}
	const checkout = async (cartId: string, token: string) =>
		svc.checkoutCart(
			await merchant(),
			cartId,
			{ payment_method: { type: "PAYPAL", token, payer_id: "PAYER-TEST" } },
			caller,
		);
	const failure = async (p: Promise<unknown>) => {
		try {
			await p;
		} catch (e) {
			if (e instanceof HttpError) return e;
			throw e;
		}
		throw new Error("expected an HttpError");
	};

	beforeAll(async () => {
		await db()
			.insert(s.merchants)
			.values({
				id: M,
				name: "Integration Store",
				paymentMode: "authorize",
				policy: {
					currency: "USD",
					shippingOptions: [
						{ id: "STANDARD", name: "Standard", baseCents: 500, perKgCents: 0, etaDays: 5, regions: ["*"] },
					],
					taxRates: { TX: 0.0825, "*": 0.06 },
					regionsServed: ["*"],
					poBoxAllowedForFragile: false,
					coupons: { firstOrderPct: 10, maxTotalPct: 15, minSubtotalCents: 0, expiresMinutes: 30 },
				},
			});
		const feed = `id,item_group_id,title,description,link,image_link,price,availability,color,size,stock_qty
${BLUE},${M}-kurta,"Kurta - Blue, M","Handloom cotton kurta used by integration tests",/p/k,/i/k.png,39.00 USD,out_of_stock,Blue,M,0
${INDIGO},${M}-kurta,"Kurta - Indigo, M","Handloom cotton kurta used by integration tests",/p/k,/i/k.png,39.00 USD,in_stock,Indigo,M,5
${BEANS},${M}-beans,"Coffee Beans","Estate coffee beans used by integration tests",/p/b,/i/b.png,16.00 USD,in_stock,,,3`;
		const report = await importFeed(M, feed, "https://shop.test");
		expect(report.skipped).toEqual([]);
	});

	beforeEach(async () => {
		fake.reset();
		// reset stock and coupons between tests
		await db().update(s.variants).set({ stockQty: 5 }).where(eq(s.variants.id, INDIGO));
		await db().update(s.variants).set({ stockQty: 3 }).where(eq(s.variants.id, BEANS));
		await db().delete(s.coupons).where(eq(s.coupons.merchantId, M));
		await db().insert(s.coupons).values({
			code: "TEST10",
			merchantId: M,
			kind: "percent",
			value: 10,
			maxUses: 1,
			used: 0,
			description: "10% off",
		});
	});

	afterAll(async () => {
		const orderIds = db().select({ id: s.orders.id }).from(s.orders).where(eq(s.orders.merchantId, M));
		const cartIds = db().select({ id: s.carts.id }).from(s.carts).where(eq(s.carts.merchantId, M));
		await db().delete(s.shipments).where(inArray(s.shipments.orderId, orderIds));
		await db().delete(s.orderItems).where(inArray(s.orderItems.orderId, orderIds));
		await db().delete(s.orders).where(eq(s.orders.merchantId, M));
		await db().delete(s.cartEvents).where(inArray(s.cartEvents.cartId, cartIds));
		await db().delete(s.carts).where(eq(s.carts.merchantId, M));
		await db().delete(s.coupons).where(eq(s.coupons.merchantId, M));
		const productIds = db().select({ id: s.products.id }).from(s.products).where(eq(s.products.merchantId, M));
		await db().delete(s.variants).where(inArray(s.variants.productId, productIds));
		await db().delete(s.products).where(eq(s.products.merchantId, M));
		await db().delete(s.merchants).where(eq(s.merchants.id, M));
		await closeDb();
	});

	it("create: 200 with issues and no token for an unbuyable cart, 201 with a PayPal token once fixed", async () => {
		const bad = await svc.createCart(
			await merchant(),
			{ items: [{ variant_id: BLUE, quantity: 1 }], ...buyer },
			caller,
		);
		expect(bad.status).toBe(200);
		const badCart = bad.body as PayPalCart;
		expect(badCart.status).toBe("INCOMPLETE");
		expect(badCart.payment_method).toEqual({ type: "paypal" });

		const fixed = await svc.updateCart(
			await merchant(),
			badCart.id!,
			{ items: [{ variant_id: INDIGO, quantity: 1 }], ...buyer },
			caller,
		);
		const cart = fixed.body as PayPalCart;
		expect(cart.validation_status).toBe("VALID");
		expect(fake.orders.get(cart.payment_method!.token!)?.amountCents).toBe(
			Number(cart.totals!.total.value.replace(".", "")),
		);

		const ok = await svc.createCart(
			await merchant(),
			{ items: [{ variant_id: INDIGO, quantity: 1 }], ...buyer },
			caller,
		);
		expect(ok.status).toBe(201);
	});

	it("checkout: authorizes, reserves stock, consumes the coupon, completes the cart; replay is idempotent", async () => {
		const { cart, token } = await readyCart(
			[{ variant_id: INDIGO, quantity: 2 }],
			[{ code: "TEST10", action: "APPLY" }],
		);
		fake.approve(token);
		const done = await checkout(cart.id!, token);
		const body = done.body as PayPalCart;
		expect(body.status).toBe("COMPLETED");
		expect(body.payment_method).toMatchObject({ type: "paypal", token, payer_id: "PAYER-TEST" });
		const orderNo = body.payment_confirmation!.merchant_order_number;
		expect(body.payment_confirmation?.order_review_page).toMatch(new RegExp(`/m/${M}/orders/${orderNo}\\?k=`));

		const [order] = await ordersFor(token);
		expect(order).toMatchObject({
			id: orderNo,
			status: "AUTHORIZED",
			authorizationId: "AUTH-1",
			couponCodes: ["TEST10"],
		});
		expect(await stock(INDIGO)).toBe(3);
		const [coupon] = await db()
			.select()
			.from(s.coupons)
			.where(and(eq(s.coupons.merchantId, M), eq(s.coupons.code, "TEST10")));
		expect(coupon.used).toBe(1);

		const replay = await checkout(cart.id!, token);
		expect(replay.body).toEqual(body);
		expect(fake.charges).toBe(1);
	});

	it("decline: stock and coupon are handed back and no order is left behind", async () => {
		const { cart, token } = await readyCart(
			[{ variant_id: INDIGO, quantity: 2 }],
			[{ code: "TEST10", action: "APPLY" }],
		);
		fake.approve(token);
		fake.next.charge = { kind: "decline", issue: "INSTRUMENT_DECLINED" };
		const e = await failure(checkout(cart.id!, token));
		expect(e.status).toBe(422);
		expect(e.body.details?.[0].issue).toBe("PAYMENT_DECLINED");
		expect(await stock(INDIGO)).toBe(5);
		expect(await ordersFor(token)).toEqual([]);
		const [coupon] = await db()
			.select()
			.from(s.coupons)
			.where(and(eq(s.coupons.merchantId, M), eq(s.coupons.code, "TEST10")));
		expect(coupon.used).toBe(0);
	});

	it("a 201 with a DENIED authorization is still a decline", async () => {
		const { cart, token } = await readyCart();
		fake.approve(token);
		fake.next.charge = { kind: "status", status: "DENIED" };
		const e = await failure(checkout(cart.id!, token));
		expect(e.status).toBe(422);
		expect(await stock(INDIGO)).toBe(5);
		expect(await ordersFor(token)).toEqual([]);
	});

	it("PayPal authorizing a different amount voids it and releases the reservation", async () => {
		const { cart, token } = await readyCart();
		fake.approve(token);
		fake.next.charge = { kind: "amount", amountCents: 100 };
		const e = await failure(checkout(cart.id!, token));
		expect(e.status).toBe(409);
		expect(e.body.name).toBe("CART_CHANGED_DURING_CHECKOUT");
		expect(fake.voided).toEqual(["AUTH-1"]);
		expect(await stock(INDIGO)).toBe(5);
	});

	it("a cart edit that arrives while PayPal is authorizing is rejected", async () => {
		const { cart, token } = await readyCart();
		fake.approve(token);
		let concurrent: HttpError | undefined;
		fake.next.charge = {
			kind: "during",
			fn: async () => {
				concurrent = await failure(
					svc.updateCart(
						await merchant(),
						cart.id!,
						{ items: [{ variant_id: INDIGO, quantity: 1 }], ...buyer },
						caller,
					),
				);
			},
		};
		const done = await checkout(cart.id!, token);
		expect((done.body as PayPalCart).status).toBe("COMPLETED");
		expect(concurrent?.status).toBe(409);
		expect(fake.orders.get(token)?.amountCents).toBe(
			Number((done.body as PayPalCart).totals!.total.value.replace(".", "")),
		);
	});

	it("a lost PayPal response keeps the reservation; the retry resumes it without charging twice", async () => {
		const { cart, token } = await readyCart();
		fake.approve(token);
		fake.next.charge = { kind: "lost-response" };
		const e = await failure(checkout(cart.id!, token));
		expect(e.status).toBe(502);
		const [pending] = await ordersFor(token);
		expect(pending.status).toBe("PENDING");
		expect(await stock(INDIGO)).toBe(3);

		const done = await checkout(cart.id!, token);
		expect((done.body as PayPalCart).status).toBe("COMPLETED");
		expect(fake.charges).toBe(1);
		expect(await stock(INDIGO)).toBe(3);
		const [order] = await ordersFor(token);
		expect(order.status).toBe("AUTHORIZED");
	});

	it("an item that sells out between validation and reservation fails cleanly", async () => {
		const { cart, token } = await readyCart([{ variant_id: BEANS, quantity: 3 }]);
		fake.approve(token);
		// someone else buys the beans while we talk to PayPal
		fake.next.getOrder = async () => {
			await db().update(s.variants).set({ stockQty: 1 }).where(eq(s.variants.id, BEANS));
		};
		const e = await failure(checkout(cart.id!, token));
		expect(e.status).toBe(422);
		expect(e.body.details?.[0].issue).toBe("ITEM_OUT_OF_STOCK");
		expect(await ordersFor(token)).toEqual([]);
		expect(fake.charges).toBe(0);
		// the version claim rolled back with the reservation, so the cart can still be edited
		const edited = await svc.updateCart(
			await merchant(),
			cart.id!,
			{ items: [{ variant_id: BEANS, quantity: 1 }], ...buyer },
			caller,
		);
		expect((edited.body as PayPalCart).validation_status).toBe("VALID");
	});

	it("refuses checkout before approval and when the approved amount differs", async () => {
		const { cart, token } = await readyCart();
		const notApproved = await failure(checkout(cart.id!, token));
		expect(notApproved.body.details?.[0].issue).toBe("PAYER_ACTION_REQUIRED");

		fake.approve(token);
		fake.orders.get(token)!.amountCents += 500;
		const changed = await failure(checkout(cart.id!, token));
		expect(changed.body.details?.[0].issue).toBe("AMOUNT_CHANGED");
		expect(fake.charges).toBe(0);
	});

	it("checkout validates its inputs and a cart is invisible to other callers", async () => {
		const { cart, token } = await readyCart();
		const m = await merchant();
		const missingPayer = await failure(
			svc.checkoutCart(m, cart.id!, { payment_method: { type: "paypal", token } }, caller),
		);
		expect(missingPayer.status).toBe(400);
		const wrongToken = await failure(
			svc.checkoutCart(m, cart.id!, { payment_method: { type: "paypal", token: "PP-OTHER", payer_id: "X" } }, caller),
		);
		expect(wrongToken.body.details?.[0].issue).toBe("INVALID_TOKEN");
		expect((await failure(svc.getCart(m, cart.id!, stranger))).status).toBe(404);
		expect((await failure(svc.getCart(m, "not-a-cart", caller))).status).toBe(400);
	});
});
