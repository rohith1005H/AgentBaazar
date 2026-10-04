/**
 * End-to-end check of the merchant contract against a running server (`pnpm dev`)
 * and the real PayPal sandbox:
 *
 *   1. search the store                  -> the kurta is found
 *   2. create a cart for Blue M          -> ITEM_OUT_OF_STOCK with an auto-applicable variant swap
 *   3. apply the patch, PUT              -> VALID, PayPal order token + approval_url
 *   4. ask for an offer, apply it, PUT   -> discount applied, PayPal order patched to the new total
 *   5. buyer approves in PayPal          -> (prints the link and waits, or --payer <id>)
 *   6. checkout                          -> COMPLETED, merchant order number, authorization (no capture)
 *   7. replay checkout                   -> same response (idempotent)
 *   8. ship                              -> authorization captured, tracking posted
 *   9. order status                      -> CAPTURED with tracking
 *  10. refund $5 twice, one request_id   -> one PayPal refund, order PARTIALLY_REFUNDED
 *
 *   pnpm smoke [--payer PAYER_ID] [--no-ship]
 */
import { eq } from "drizzle-orm";
import type { CartPatch } from "@/src/cart-spec/extensions";
import type { ApiError, PayPalCart } from "@/src/cart-spec/schema";
import { closeDb, db } from "@/src/db/client";
import { stores } from "@/src/db/schema";
import { envCreds } from "@/src/merchant/paypal/http";
import { getOrder } from "@/src/merchant/paypal/orders";
import { applyCoupon, applyPatch, requestFromCart } from "@/src/platform/agent/patch";
import { cartClient, type OfferResult, type Reply, type SearchResult } from "@/src/platform/stores/cart-client";

const STORE = "patel-textiles";
const arg = (name: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};

function ok(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`✗ ${msg}`);
	console.log(`✓ ${msg}`);
}
function cart(r: Reply<PayPalCart>): PayPalCart {
	if (!r.ok) throw new Error(`✗ HTTP ${r.status}: ${JSON.stringify(r.body)}`);
	return r.body as PayPalCart;
}
const specific = (c: PayPalCart) =>
	(c.validation_issues ?? []).map(
		(i) => (i.context as { specific_issue?: string } | undefined)?.specific_issue ?? i.code,
	);

async function main() {
	const [store] = await db().select().from(stores).where(eq(stores.id, STORE));
	ok(store, `store ${STORE} is registered (run pnpm seed)`);
	const api = cartClient(store);
	const buyer = {
		customer: { name: { given_name: "Rohan", surname: "Mehta" }, email_address: `rohan+${Date.now()}@example.com` },
		shipping_address: {
			address_line_1: "100 Congress Ave",
			admin_area_2: "Austin",
			admin_area_1: "TX",
			postal_code: "78701",
			country_code: "US",
		},
	};

	// 1. search
	const found = await api.search("blue cotton kurta", 4000);
	const products = (found.body as SearchResult).products;
	ok(products?.[0]?.product_id === "kurta-001", `search finds the handloom kurta (${products?.length} results)`);

	// 2. create with an out-of-stock variant
	let c = cart(await api.create({ items: [{ variant_id: "kurta-001-blue-m", quantity: 1 }], ...buyer }));
	ok(
		c.status === "INCOMPLETE" && specific(c).includes("ITEM_OUT_OF_STOCK"),
		`create: ${c.id} INCOMPLETE, ITEM_OUT_OF_STOCK`,
	);
	const swap = c.validation_issues?.[0].resolution_options?.[0];
	ok(
		swap?.action === "CHOOSE_DIFFERENT_VARIANT" && swap.metadata?.auto_applicable === true,
		`resolution: ${swap?.label}`,
	);
	ok(!c.payment_method?.token, "no payment token while the cart is invalid");

	// 3. apply the machine-readable patch
	c = cart(await api.update(c.id!, applyPatch(requestFromCart(c), swap.metadata?.apply as CartPatch)));
	ok(
		c.validation_status === "VALID" && c.payment_method?.token,
		`update: VALID, PayPal order ${c.payment_method?.token}`,
	);
	const firstTotal = c.totals!.total.value;

	// 4. negotiate within merchant policy
	const offer = (await api.offer(c.id!, "first order")).body as OfferResult;
	ok(offer.offer, `offer: ${offer.offer?.code} (${offer.offer?.description})`);
	c = cart(await api.update(c.id!, applyCoupon(requestFromCart(c), offer.offer.code)));
	ok(
		c.applied_coupons?.[0]?.code === offer.offer.code,
		`coupon applied, total ${firstTotal} -> ${c.totals!.total.value}`,
	);
	const token = c.payment_method!.token!;
	const order = await getOrder(envCreds(), token);
	ok(
		order.purchaseUnits?.[0]?.amount?.value === c.totals!.total.value,
		"PayPal order amount patched to match the cart",
	);

	// 5. human approval
	let payerId = arg("payer");
	if (!payerId) {
		console.log(`\n→ Approve as the sandbox buyer:\n  ${c.payment_method!.approval_url}\n`);
		payerId = await waitForApproval(token);
	}
	ok(payerId, `buyer approved (payer ${payerId})`);

	// 6. checkout
	const done = cart(
		await api.checkout(c.id!, { ...requestFromCart(c), payment_method: { type: "paypal", token, payer_id: payerId } }),
	);
	const orderNo = done.payment_confirmation?.merchant_order_number;
	ok(done.status === "COMPLETED" && orderNo, `checkout: COMPLETED, order ${orderNo}`);
	const after = await getOrder(envCreds(), token);
	const auth = after.purchaseUnits?.[0]?.payments?.authorizations?.[0];
	ok(
		auth?.status === "CREATED" && !after.purchaseUnits?.[0]?.payments?.captures?.length,
		`authorized ${auth?.amount?.value}, not captured`,
	);

	// 7. idempotent replay
	const again = await api.checkout(c.id!, { payment_method: { type: "paypal", token, payer_id: payerId } });
	ok(
		again.status === 200 && (again.body as PayPalCart).payment_confirmation?.merchant_order_number === orderNo,
		"checkout replay is idempotent",
	);

	if (process.argv.includes("--no-ship")) return;

	// 8. ship -> capture
	const base = store.baseUrl.replace(/\/paypal\/v1$/, "");
	const shipRes = await fetch(`${base}/orders/${orderNo}/ship`, {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.STORE_ADMIN_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify({ carrier: "UPS", tracking_number: `1Z999AA1${Date.now().toString().slice(-8)}` }),
	});
	const shipped = (await shipRes.json()) as { status: string; capture_id: string; tracking_posted: boolean } | ApiError;
	ok(
		shipRes.ok && "capture_id" in shipped,
		`ship: captured ${"capture_id" in shipped ? shipped.capture_id : JSON.stringify(shipped)}`,
	);
	ok("tracking_posted" in shipped && shipped.tracking_posted, "tracking posted to PayPal");

	// 9. order status, as the agent sees it
	const status = (await api.order(orderNo!)).body as { status: string; shipments: { tracking_number: string }[] };
	ok(
		status.status === "CAPTURED" && status.shipments.length === 1,
		`order status: ${status.status}, tracking ${status.shipments[0]?.tracking_number}`,
	);

	// 10. partial refund, sent twice with one request_id: PayPal refunds once
	const refund = () =>
		fetch(`${base}/orders/${orderNo}/refund`, {
			method: "POST",
			headers: { Authorization: `Bearer ${process.env.STORE_ADMIN_TOKEN}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				amount: { currency_code: "USD", value: "5.00" },
				reason: "Smoke test partial refund",
				request_id: `smoke-${orderNo}-refund`,
			}),
		}).then((r) => r.json() as Promise<{ status?: string; refund_id?: string }>);
	const first = await refund();
	const retried = await refund();
	ok(first.status === "PARTIALLY_REFUNDED", `refund $5.00: ${first.refund_id}, order PARTIALLY_REFUNDED`);
	ok(retried.refund_id === first.refund_id, "refund retried with the same request_id: same refund, no double refund");
	console.log(`\nSmoke passed.\n\nThe buyer's order page:\n  ${done.payment_confirmation?.order_review_page}`);
}

async function waitForApproval(token: string): Promise<string> {
	const deadline = Date.now() + 15 * 60_000;
	let last = "";
	while (Date.now() < deadline) {
		const o = await getOrder(envCreds(), token);
		if (o.status !== last) console.log(`  PayPal order status: ${o.status}`);
		last = o.status ?? "";
		if (o.status === "APPROVED" && o.payer?.payerId) return o.payer.payerId;
		await new Promise((r) => setTimeout(r, 3000));
	}
	throw new Error("Timed out waiting for approval");
}

main()
	.catch((e) => {
		const cause = (e as { cause?: { message?: string } }).cause?.message;
		console.error(e instanceof Error ? e.message : e, cause ? `\n  cause: ${cause}` : "");
		process.exitCode = 1;
	})
	.finally(closeDb);
