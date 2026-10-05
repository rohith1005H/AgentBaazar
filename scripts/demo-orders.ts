/**
 * Real order history for the demo console, across all three stores. Each order goes
 * through the stores' Cart API the way an agent platform's would (signed JWT), takes the
 * store's offer, is approved by the sandbox buyer in PayPal, and is checked out; some are
 * then shipped (PayPal capture + tracking) and one is partly refunded.
 *
 *   pnpm demo-orders          prints each PayPal link and waits for you to approve it
 *
 * APPROVER, if set, is a command run with each approval link (e.g. a headless browser
 * script that logs in as the sandbox buyer), so the whole run is hands-free.
 */
import { spawn } from "node:child_process";
import { eq } from "drizzle-orm";
import type { CartPatch } from "@/src/cart-spec/extensions";
import type { PayPalCart } from "@/src/cart-spec/schema";
import { closeDb, db } from "@/src/db/client";
import { stores } from "@/src/db/schema";
import { applyCoupon, applyPatch, requestFromCart } from "@/src/platform/agent/patch";
import { cartClient, type OfferResult } from "@/src/platform/stores/cart-client";

type Plan = {
	store: string;
	items: { variant_id: string; quantity: number }[];
	buyer: [given: string, surname: string, street: string, city: string, state: string, zip: string];
	ship?: boolean;
	refund?: string;
};

const PLANS: Plan[] = [
	{
		store: "kaveri-coffee",
		items: [{ variant_id: "attikan-500", quantity: 1 }],
		buyer: ["Maya", "Iyer", "245 Court St", "Brooklyn", "NY", "11201"],
		ship: true,
	},
	{
		store: "lumen-ceramics",
		items: [{ variant_id: "planter-s", quantity: 2 }],
		buyer: ["Ari", "Cohen", "1550 N Damen Ave", "Chicago", "IL", "60622"],
		ship: true,
		refund: "5.00",
	},
	{
		store: "kaveri-coffee",
		items: [{ variant_id: "filter-set", quantity: 1 }],
		buyer: ["Priya", "Nair", "1501 4th Ave", "Seattle", "WA", "98101"],
	},
	{
		store: "patel-textiles",
		items: [{ variant_id: "stole-001-teal", quantity: 1 }],
		buyer: ["Leah", "Park", "2100 Sunset Blvd", "Los Angeles", "CA", "90026"],
		ship: true,
	},
	{
		store: "lumen-ceramics",
		items: [{ variant_id: "mugs-4-sand", quantity: 1 }],
		buyer: ["Sam", "Ortiz", "600 Congress Ave", "Austin", "TX", "78701"],
	},
	{
		store: "kaveri-coffee",
		items: [{ variant_id: "malabar-250", quantity: 2 }],
		buyer: ["Dev", "Rao", "300 Bay St", "Tampa", "FL", "33602"],
		ship: true,
	},
];

const store = async (id: string) => {
	const [s] = await db().select().from(stores).where(eq(stores.id, id));
	if (!s) throw new Error(`store ${id} is not registered (run pnpm seed)`);
	return s;
};

function body(r: { ok: boolean; status: number; body: unknown }): PayPalCart {
	if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
	return r.body as PayPalCart;
}

async function admin(base: string, path: string, json: unknown) {
	const res = await fetch(`${base}${path}`, {
		method: "POST",
		headers: { Authorization: `Bearer ${process.env.STORE_ADMIN_TOKEN}`, "Content-Type": "application/json" },
		body: JSON.stringify(json),
	});
	const out = (await res.json()) as Record<string, unknown>;
	if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(out).slice(0, 200)}`);
	return out;
}

async function placeOrder(plan: Plan, n: number) {
	const s = await store(plan.store);
	const api = cartClient(s, `demo-${n}`);
	const [given_name, surname, address_line_1, admin_area_2, admin_area_1, postal_code] = plan.buyer;
	let c = body(
		await api.create({
			items: plan.items,
			customer: { name: { given_name, surname }, email_address: `demo+${Date.now()}-${n}@example.com` },
			shipping_address: { address_line_1, admin_area_2, admin_area_1, postal_code, country_code: "US" },
		}),
	);
	// Apply the store's own automatic fix for anything it flags (e.g. an out-of-stock variant).
	for (let i = 0; i < 3 && c.validation_status !== "VALID"; i++) {
		const patch = c.validation_issues?.[0]?.resolution_options?.find((o) => o.metadata?.apply)?.metadata?.apply;
		if (!patch)
			throw new Error(`cart ${c.id} needs a fix this script cannot apply: ${c.validation_issues?.[0]?.message}`);
		c = body(await api.update(c.id!, applyPatch(requestFromCart(c), patch as CartPatch)));
	}
	const offer = (await api.offer(c.id!, "first order")).body as OfferResult;
	if (offer.offer) c = body(await api.update(c.id!, applyCoupon(requestFromCart(c), offer.offer.code)));
	const url = c.payment_method?.approval_url;
	if (c.validation_status !== "VALID" || !url) throw new Error(`cart ${c.id} is not ready to pay`);

	console.log(
		`\n${plan.store}: ${c.items?.map((i) => `${i.quantity} x ${i.name}`).join(", ")}, total $${c.totals?.total.value}${offer.offer ? ` (${offer.offer.code})` : ""}`,
	);
	console.log(`  approve: ${url}`);
	// PayPal approval links are plain https URLs; refuse anything else before handing it to a shell.
	if (process.env.APPROVER && /^https:\/\/[\w.-]+\/[\w/?=&.-]*$/.test(url))
		spawn(`${process.env.APPROVER} '${url}'`, { shell: true, stdio: "ignore" });

	// The store's GET shows the payer once PayPal has the buyer's approval.
	const deadline = Date.now() + 10 * 60_000;
	let payerId: string | undefined;
	while (!payerId && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 3000));
		payerId = body(await api.get(c.id!)).payment_method?.payer_id;
	}
	if (!payerId) throw new Error(`no approval for ${c.id} within 10 minutes`);

	const done = body(
		await api.checkout(c.id!, {
			payment_method: { type: "paypal", token: c.payment_method!.token, payer_id: payerId },
		}),
	);
	const orderId = done.payment_confirmation!.merchant_order_number;
	console.log(`  ✓ order ${orderId}: authorized $${done.totals?.total.value}`);

	const base = s.baseUrl.replace(/\/paypal\/v1$/, "");
	if (plan.ship) {
		const shipped = await admin(base, `/orders/${orderId}/ship`, {
			carrier: "UPS",
			tracking_number: `1Z999AA1${Date.now().toString().slice(-8)}`,
		});
		console.log(`  ✓ shipped: captured ${shipped.capture_id}, tracking posted ${shipped.tracking_posted}`);
	}
	if (plan.refund) {
		const r = await admin(base, `/orders/${orderId}/refund`, {
			amount: { currency_code: "USD", value: plan.refund },
			reason: "Demo: one planter arrived chipped",
			request_id: `demo-${orderId}-refund`,
		});
		console.log(`  ✓ refunded $${plan.refund}: ${r.refund_id}`);
	}
}

async function main() {
	for (const [n, plan] of PLANS.entries()) await placeOrder(plan, n);
	console.log("\nDemo orders placed.");
}

main()
	.catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exitCode = 1;
	})
	.finally(closeDb);
