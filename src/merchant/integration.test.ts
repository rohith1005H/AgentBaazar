/**
 * The merchant side against a real Postgres (a Neon branch, TEST_DATABASE_URL) with an
 * in-memory PayPal. Covers every money-moving path: checkout (idempotent replay, declines,
 * PayPal answers that do not match what we expected, lost responses, carts edited while
 * being paid for), ship / cancel / refund, and webhook reconciliation.
 *
 * Skipped when TEST_DATABASE_URL is not set.
 */
import { and, eq, inArray, like } from "drizzle-orm";
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
	process.env.CHECKOUT_LEASE_MS = "0";
	process.env.WEBHOOK_VERIFY = "skip";
	process.env.LOG_LEVEL = "silent";

	const { fake, refundCapture } = await import("@/src/test/fake-paypal");
	const { stableRequestId } = await import("@/src/crypto");
	const { closeDb, db } = await import("@/src/db/client");
	const s = await import("@/src/db/schema");
	const { importFeed } = await import("@/src/merchant/catalog/import");
	const svc = await import("./cart/service");
	const repo = await import("./cart/repo");
	const ful = await import("./fulfillment");
	const { handleWebhook } = await import("./webhooks");

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
	const orderRow = async (id: string) => (await db().select().from(s.orders).where(eq(s.orders.id, id)))[0];
	const couponUsed = async () =>
		(
			await db()
				.select()
				.from(s.coupons)
				.where(and(eq(s.coupons.merchantId, M), eq(s.coupons.code, "TEST10")))
		)[0].used;
	/** A checked-out (AUTHORIZED) order. */
	async function paidOrder(coupons?: { code: string; action: "APPLY" }[]) {
		const { cart, token } = await readyCart([{ variant_id: INDIGO, quantity: 2 }], coupons);
		fake.approve(token);
		const done = (await checkout(cart.id!, token)).body as PayPalCart;
		return { cart, token, orderId: done.payment_confirmation!.merchant_order_number };
	}
	let events = 0;
	/** Deliver a PayPal webhook (signature checks are off in this suite: WEBHOOK_VERIFY=skip). */
	const deliver = (event_type: string, resource: Record<string, unknown>, id = `WH-${M}-${++events}`) =>
		handleWebhook(
			new Request("https://shop.test/api/paypal/webhooks", {
				method: "POST",
				body: JSON.stringify({ id, event_type, resource }),
			}),
		).then((r) => ({ id, ...(r.body as { duplicate?: boolean }) }));
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
		await db()
			.delete(s.webhookEvents)
			.where(like(s.webhookEvents.id, `WH-${M}-%`));
		await db().delete(s.refunds).where(inArray(s.refunds.orderId, orderIds));
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
		expect(cart.status).toBe("READY");
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
			authorizationId: fake.authorizationOf(token),
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
		expect(fake.voided).toEqual([fake.authorizationOf(token)]);
		expect(await stock(INDIGO)).toBe(5);
		// the voided PayPal order is detached and the cart says it needs approval; a PUT issues a fresh order
		const m = await merchant();
		const detached = (await svc.getCart(m, cart.id!, caller)).body as PayPalCart;
		expect(detached.payment_method).toEqual({ type: "paypal" });
		expect(detached.status).toBe("INCOMPLETE");
		expect(detached.validation_issues?.[0]).toMatchObject({ code: "PAYMENT_ERROR" });
		const put = await svc.updateCart(m, cart.id!, { items: [{ variant_id: INDIGO, quantity: 2 }], ...buyer }, caller);
		const fresh = (put.body as PayPalCart).payment_method!.token;
		expect(fresh).toBeTruthy();
		expect(fresh).not.toBe(token);
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

	it("a retry while the first attempt may still be talking to PayPal gets 409, not a second charge", async () => {
		const { cart, token } = await readyCart();
		fake.approve(token);
		fake.next.charge = { kind: "lost-response" };
		process.env.CHECKOUT_LEASE_MS = "600000";
		try {
			expect((await failure(checkout(cart.id!, token))).status).toBe(502);
			const busy = await failure(checkout(cart.id!, token));
			expect(busy.status).toBe(409);
			expect(busy.body.name).toBe("CHECKOUT_IN_PROGRESS");
		} finally {
			process.env.CHECKOUT_LEASE_MS = "0";
		}
		// once the lease has run out, the retry reads the authorization back from PayPal
		await db()
			.update(s.orders)
			.set({ chargingUntil: new Date(Date.now() - 1000) })
			.where(eq(s.orders.paypalOrderId, token));
		expect(((await checkout(cart.id!, token)).body as PayPalCart).status).toBe("COMPLETED");
		expect(fake.charges).toBe(1);
	});

	it("if the reservation is released while PayPal is charging, the charge is voided", async () => {
		const { cart, token } = await readyCart();
		fake.approve(token);
		fake.next.charge = {
			kind: "during",
			// what a competing attempt's release() leaves behind
			fn: async () => {
				const [o] = await ordersFor(token);
				await db().delete(s.orderItems).where(eq(s.orderItems.orderId, o.id));
				await db().delete(s.orders).where(eq(s.orders.id, o.id));
			},
		};
		const e = await failure(checkout(cart.id!, token));
		expect(e.status).toBe(409);
		expect(e.body.name).toBe("CHECKOUT_CONFLICT");
		expect(fake.voided).toEqual([fake.authorizationOf(token)]);
	});

	it("a charge that cannot be voided is left on record for the merchant", async () => {
		const { cart, token } = await readyCart();
		fake.approve(token);
		fake.next.voidFails = true;
		fake.next.charge = { kind: "amount", amountCents: 100 };
		await expect(checkout(cart.id!, token)).rejects.toThrow();
		const trail = await db().select().from(s.cartEvents).where(eq(s.cartEvents.cartId, cart.id!));
		expect(trail.map((e) => e.data)).toContainEqual(
			expect.objectContaining({
				undo_failed: expect.objectContaining({ authorization_id: fake.authorizationOf(token) }),
			}),
		);
		// the reservation is still there, so a retry resumes and finishes the job
		expect((await ordersFor(token))[0].status).toBe("PENDING");
	});

	it("GET shows READY, and the payer once PayPal reports the approval", async () => {
		const { cart, token } = await readyCart();
		const m = await merchant();
		const before = (await svc.getCart(m, cart.id!, caller)).body as PayPalCart;
		expect(before.status).toBe("READY");
		expect(before.payment_method?.payer_id).toBeUndefined();
		await deliver("CHECKOUT.ORDER.APPROVED", { id: token, status: "APPROVED", payer: { payer_id: "PAYER-TEST" } });
		const after = (await svc.getCart(m, cart.id!, caller)).body as PayPalCart;
		expect(after.payment_method).toMatchObject({ token, payer_id: "PAYER-TEST" });
	});

	it("a cart that cannot check out says why in business_context, with the fix", async () => {
		const { cart, token } = await readyCart([{ variant_id: BEANS, quantity: 3 }]);
		fake.approve(token);
		await db().update(s.variants).set({ stockQty: 0 }).where(eq(s.variants.id, BEANS));
		const e = await failure(checkout(cart.id!, token));
		expect(e.status).toBe(422);
		expect(e.body.business_context).toMatchObject({ code: "INVENTORY_ISSUE" });
	});

	it("a buyer session can only reach the carts it opened", async () => {
		const { saveSessionCart, sessionCart } = await import("@/src/platform/agent/session");
		const [a, b] = [`sa-${M}`, `sb-${M}`];
		await db()
			.insert(s.stores)
			.values({ id: M, name: "Integration Store", baseUrl: "https://shop.test/api/stores/it/paypal/v1", merchantId: M })
			.onConflictDoNothing();
		await db()
			.insert(s.sessions)
			.values([{ id: a }, { id: b }]);
		try {
			const { cart } = await readyCart();
			await saveSessionCart(a, M, cart);
			expect((await sessionCart(a, cart.id!)).cartId).toBe(cart.id);
			await expect(sessionCart(b, cart.id!)).rejects.toThrow(/Unknown cart/);
		} finally {
			await db()
				.delete(s.sessionCarts)
				.where(inArray(s.sessionCarts.sessionId, [a, b]));
			await db()
				.delete(s.sessions)
				.where(inArray(s.sessions.id, [a, b]));
			await db().delete(s.stores).where(eq(s.stores.id, M));
		}
	});

	describe("a store that captures at checkout (the Store Sync default)", () => {
		beforeAll(async () => {
			await db().update(s.merchants).set({ paymentMode: "capture" }).where(eq(s.merchants.id, M));
		});
		afterAll(async () => {
			await db().update(s.merchants).set({ paymentMode: "authorize" }).where(eq(s.merchants.id, M));
		});

		it("captures at checkout; replay is idempotent", async () => {
			const { cart, token } = await readyCart();
			fake.approve(token);
			const done = (await checkout(cart.id!, token)).body as PayPalCart;
			expect(done.status).toBe("COMPLETED");
			const [order] = await ordersFor(token);
			expect(order).toMatchObject({ status: "CAPTURED", authorizationId: null });
			expect(order.captureId).toBe(fake.orders.get(token)!.captureId);
			expect(await checkout(cart.id!, token).then((r) => r.body)).toEqual(done);
			expect(fake.charges).toBe(1);
		});

		it("a PENDING capture is recorded as CAPTURE_PENDING", async () => {
			const { cart, token } = await readyCart();
			fake.approve(token);
			fake.next.charge = { kind: "status", status: "PENDING" };
			await checkout(cart.id!, token);
			expect((await ordersFor(token))[0].status).toBe("CAPTURE_PENDING");
		});

		it("a capture for the wrong amount is refunded in full and the reservation released", async () => {
			const { cart, token } = await readyCart();
			fake.approve(token);
			fake.next.charge = { kind: "amount", amountCents: 100 };
			const e = await failure(checkout(cart.id!, token));
			expect(e.status).toBe(409);
			expect(fake.refunded).toEqual([
				expect.objectContaining({ captureId: fake.orders.get(token)!.captureId, amountCents: undefined }),
			]);
			expect(fake.voided).toEqual([]);
			expect(await stock(INDIGO)).toBe(5);
		});
	});

	describe("ship / cancel / refund", () => {
		it("ship captures the authorization and posts tracking; a declined capture changes nothing", async () => {
			const declined = await paidOrder();
			fake.next.charge = { kind: "status", status: "DECLINED" };
			const e = await failure(ful.shipOrder(M, declined.orderId, { carrier: "UPS", tracking_number: "1Z999AA1" }));
			expect(e.status).toBe(422);
			expect((await orderRow(declined.orderId)).status).toBe("AUTHORIZED");

			const ok = await paidOrder();
			const shipped = await ful.shipOrder(M, ok.orderId, { carrier: "UPS", tracking_number: "1Z999AA2" });
			const captureId = `CAP-${fake.authorizationOf(ok.token)}`;
			expect(shipped.body).toMatchObject({ status: "CAPTURED", capture_id: captureId, tracking_posted: true });
			expect(await orderRow(ok.orderId)).toMatchObject({ status: "CAPTURED", captureId });

			// the placing platform can follow the order; nobody else can see it
			const m = await merchant();
			expect((await ful.orderStatus(m, ok.orderId, caller)).body).toMatchObject({ status: "CAPTURED" });
			expect((await failure(ful.orderStatus(m, ok.orderId, stranger))).status).toBe(404);
		});

		it("cancel voids and hands back stock and coupon once, even when PayPal's VOIDED webhook follows", async () => {
			const { orderId, token } = await paidOrder([{ code: "TEST10", action: "APPLY" }]);
			expect(await stock(INDIGO)).toBe(3);
			expect(await couponUsed()).toBe(1);

			expect((await ful.cancelOrder(M, orderId)).body).toMatchObject({ status: "VOIDED" });
			expect(fake.voided).toEqual([fake.authorizationOf(token)]);
			expect(await stock(INDIGO)).toBe(5);
			expect(await couponUsed()).toBe(0);

			await deliver("PAYMENT.AUTHORIZATION.VOIDED", {
				id: fake.authorizationOf(token),
				status: "VOIDED",
				supplementary_data: { related_ids: { order_id: token } },
			});
			expect(await stock(INDIGO)).toBe(5);
			expect(await couponUsed()).toBe(0);
		});

		it("an authorization voided in PayPal returns stock and coupon through the webhook", async () => {
			const { orderId, token } = await paidOrder([{ code: "TEST10", action: "APPLY" }]);
			await deliver("PAYMENT.AUTHORIZATION.VOIDED", {
				id: fake.authorizationOf(token),
				status: "VOIDED",
				supplementary_data: { related_ids: { order_id: token } },
			});
			expect((await orderRow(orderId)).status).toBe("VOIDED");
			expect(await stock(INDIGO)).toBe(5);
			expect(await couponUsed()).toBe(0);
		});

		it("refunds need a request_id; a retried id refunds once; the refunded total drives the status", async () => {
			const { orderId } = await paidOrder();
			await ful.shipOrder(M, orderId, { carrier: "UPS", tracking_number: "1Z999AA3" });
			const five = { amount: { currency_code: "USD", value: "5.00" } };

			await expect(ful.refundOrder(M, orderId, five)).rejects.toThrow();
			const first = await ful.refundOrder(M, orderId, { ...five, request_id: "refund-one" });
			expect(first.body).toMatchObject({ status: "PARTIALLY_REFUNDED" });
			const retried = await ful.refundOrder(M, orderId, { ...five, request_id: "refund-one" });
			expect((retried.body as { refund_id: string }).refund_id).toBe((first.body as { refund_id: string }).refund_id);
			expect(fake.refunded).toHaveLength(1);

			const rest = await ful.refundOrder(M, orderId, { request_id: "refund-two" });
			expect(rest.body).toMatchObject({ status: "REFUNDED" });
			// a retry after a lost response returns the refund it made, not "nothing left to refund"
			const restAgain = await ful.refundOrder(M, orderId, { request_id: "refund-two" });
			expect((restAgain.body as { refund_id: string }).refund_id).toBe((rest.body as { refund_id: string }).refund_id);
			expect(fake.refunded).toHaveLength(2);
			expect((await failure(ful.refundOrder(M, orderId, { ...five, request_id: "refund-three" }))).status).toBe(422);
		});
	});

	describe("webhooks", () => {
		const refundedEvent = (captureId: string, refundId: string, value: string) => ({
			id: refundId,
			status: "COMPLETED",
			amount: { currency_code: "USD", value },
			links: [{ rel: "up", href: `https://api.sandbox.paypal.com/v2/payments/captures/${captureId}` }],
		});

		it("a refund made in the PayPal dashboard is recorded once, however often it is delivered", async () => {
			const { orderId } = await paidOrder();
			await ful.shipOrder(M, orderId, { carrier: "UPS", tracking_number: "1Z999AA4" });
			const { captureId } = await orderRow(orderId);

			const first = await deliver("PAYMENT.CAPTURE.REFUNDED", refundedEvent(captureId!, `${M}-R1`, "10.00"));
			const again = await deliver("PAYMENT.CAPTURE.REFUNDED", refundedEvent(captureId!, `${M}-R1`, "10.00"), first.id);
			expect(again.duplicate).toBe(true);
			expect((await orderRow(orderId)).status).toBe("PARTIALLY_REFUNDED");
			const rows = await db().select().from(s.refunds).where(eq(s.refunds.orderId, orderId));
			expect(rows.map((r) => r.amountCents)).toEqual([1000]);
		});

		it("a refund retry still returns the original refund when its webhook was recorded first", async () => {
			const { orderId } = await paidOrder();
			await ful.shipOrder(M, orderId, { carrier: "UPS", tracking_number: "1Z999AA6" });
			const order = await orderRow(orderId);
			// the admin's "refund the rest" reaches PayPal, but its response is lost...
			const made = await refundCapture(null, order.captureId!, stableRequestId(`${orderId}-refund-lost-one`), {
				amountCents: order.totalCents,
			});
			// ...and PayPal's webhook records the refund before the admin retries
			await deliver(
				"PAYMENT.CAPTURE.REFUNDED",
				refundedEvent(order.captureId!, made.refundId, (order.totalCents / 100).toFixed(2)),
			);
			expect((await orderRow(orderId)).status).toBe("REFUNDED");

			const retried = await ful.refundOrder(M, orderId, { request_id: "lost-one" });
			expect(retried.body).toMatchObject({ status: "REFUNDED", refund_id: made.refundId });
			expect(fake.refunded).toHaveLength(1);
			// a genuinely new refund on a fully refunded order is still refused
			const refused = await failure(ful.refundOrder(M, orderId, { request_id: "another-one" }));
			expect(refused.status).toBe(422);
			expect(refused.body.details?.[0].issue).toBe("REFUND_AMOUNT_EXCEEDED");
		});

		it("an event whose processing failed half way is applied when PayPal redelivers it", async () => {
			const { orderId } = await paidOrder();
			await ful.shipOrder(M, orderId, { carrier: "UPS", tracking_number: "1Z999AA5" });
			const { captureId } = await orderRow(orderId);
			const resource = refundedEvent(captureId!, `${M}-R2`, "3.00");
			// stored, never processed: what a crash between the insert and reconcile leaves
			const id = `WH-${M}-crashed`;
			await db()
				.insert(s.webhookEvents)
				.values({ id, eventType: "PAYMENT.CAPTURE.REFUNDED", verified: true, raw: { resource } });

			const redelivered = await deliver("PAYMENT.CAPTURE.REFUNDED", resource, id);
			expect(redelivered.duplicate).toBeUndefined();
			expect((await orderRow(orderId)).status).toBe("PARTIALLY_REFUNDED");
			expect((await deliver("PAYMENT.CAPTURE.REFUNDED", resource, id)).duplicate).toBe(true);
		});
	});
});
