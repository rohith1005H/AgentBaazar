/**
 * The buyer agent's tools. Every tool talks to stores the way any agent platform would:
 * over the store's Cart API with a signed JWT (see cart-client.ts), never through the
 * merchant's database.
 *
 * Tool results are compact views (`CartView`, `ProductView`) so the model gets what it
 * needs within free-tier token budgets, and the chat UI renders the same objects as cards.
 */
import { tool } from "ai";
import { z } from "zod";
import type { CartPatch } from "@/src/cart-spec/extensions";
import type { ApiError, Money, PayPalCart, ValidationIssue } from "@/src/cart-spec/schema";
import { toCents } from "@/src/merchant/cart/money";
import { cartClient, type Reply } from "@/src/platform/stores/cart-client";
import { applyCoupon, applyPatch, requestFromCart } from "./patch";
import { enabledStores, type Session, saveSessionCart, sessionCart, setMandate, storeRef } from "./session";
import { searchWeb, webSearchEnabled } from "./web-search";

// ---------------------------------------------------------------- views

const usd = (m?: Money) => (m ? `$${m.value}` : undefined);

export type IssueView = {
	issue: number;
	code: string;
	problem: string;
	variant_id?: string;
	options: { option: number; action: string; label: string; cost_impact?: string; automatic: boolean }[];
};

export type CartView = {
	cart_id: string;
	store_id: string;
	status: string;
	items: { variant_id?: string; name?: string; quantity: number; unit_price?: string }[];
	totals?: { subtotal?: string; discount?: string; shipping?: string; tax?: string; total: string };
	total_cents?: number;
	coupons: string[];
	shipping_options: { id: string; name: string; price: string; delivery?: string; selected: boolean }[];
	issues: IssueView[];
	ready_for_payment: boolean;
	order?: { order_id: string; order_page?: string };
};

function issueView(i: ValidationIssue, index: number): IssueView {
	const specific = (i.context as { specific_issue?: string } | undefined)?.specific_issue;
	return {
		issue: index,
		code: specific ?? i.code,
		problem: i.user_message ?? i.message,
		...(i.variant_id && { variant_id: i.variant_id }),
		options: (i.resolution_options ?? []).map((o, n) => ({
			option: n,
			action: o.action,
			label: o.label,
			...(typeof o.metadata?.cost_impact === "string" && { cost_impact: o.metadata.cost_impact }),
			automatic: Boolean(o.metadata?.apply),
		})),
	};
}

export function cartView(storeId: string, c: PayPalCart): CartView {
	const t = c.totals;
	return {
		cart_id: c.id!,
		store_id: storeId,
		status: c.status ?? "UNKNOWN",
		items: (c.items ?? []).map((i) => ({
			variant_id: i.variant_id,
			name: i.name,
			quantity: i.quantity,
			unit_price: usd(i.price),
		})),
		...(t && {
			totals: {
				subtotal: usd(t.subtotal),
				discount: usd(t.discount),
				shipping: usd(t.shipping),
				tax: usd(t.tax),
				total: usd(t.total)!,
			},
			total_cents: toCents(t.total.value),
		}),
		coupons: (c.applied_coupons ?? []).map((x) => x.code),
		shipping_options: (c.available_shipping_options ?? []).map((o) => ({
			id: o.id,
			name: o.name,
			price: usd(o.price)!,
			...(o.estimated_delivery && { delivery: o.estimated_delivery }),
			selected: o.is_selected,
		})),
		issues: (c.validation_issues ?? []).map(issueView),
		ready_for_payment: c.validation_status === "VALID" && Boolean(c.payment_method?.token),
		...(c.payment_confirmation && {
			order: {
				order_id: c.payment_confirmation.merchant_order_number,
				order_page: c.payment_confirmation.order_review_page,
			},
		}),
	};
}

export type ProductView = {
	store_id: string;
	store_name: string;
	product_id: string;
	title: string;
	image_url: string | null;
	url: string | null;
	agent_checkout: boolean;
	variants: { variant_id: string; label: string; price: string; availability: string }[];
};

// ---------------------------------------------------------------- helpers

type Failure = { error: string; details?: string[] };

/** A merchant reply as a cart, or the merchant's error as something the model can read. */
function asCart(r: Reply<PayPalCart>): PayPalCart | Failure {
	if (r.ok) return r.body as PayPalCart;
	const e = r.body as ApiError;
	return { error: `${e.name}: ${e.message}`, details: e.details?.map((d) => `${d.issue}: ${d.description}`) };
}
const failed = (x: unknown): x is Failure => typeof x === "object" && x !== null && "error" in x;

const Items = z
	.array(z.object({ variant_id: z.string(), quantity: z.number().int().min(1).max(10) }))
	.min(1)
	.max(10);

// ---------------------------------------------------------------- tools

export function shopperTools(session: Session) {
	/** PUT the full next version of a cart this session owns, and remember the answer. */
	async function put(cartId: string, next: (cart: PayPalCart) => ReturnType<typeof requestFromCart>) {
		const sc = await sessionCart(session.id, cartId);
		const store = await storeRef(sc.storeId);
		const cart = asCart(await cartClient(store).update(cartId, next(sc.cart)));
		if (failed(cart)) return cart;
		await saveSessionCart(session.id, sc.storeId, cart);
		return cartView(sc.storeId, cart);
	}

	return {
		set_budget: tool({
			description:
				"Record the buyer's spending limit (the most the whole order may cost, shipping and tax included) and an optional latest delivery date. Do this before building a cart.",
			inputSchema: z.object({
				max_total: z
					.string()
					.regex(/^\d+(\.\d{1,2})?$/)
					.describe('Decimal US dollars, e.g. "60.00"'),
				deliver_by: z
					.string()
					.regex(/^\d{4}-\d{2}-\d{2}$/)
					.optional()
					.describe("YYYY-MM-DD"),
			}),
			execute: async ({ max_total, deliver_by }) => {
				const mandate = { max_total_cents: toCents(max_total), ...(deliver_by && { deliver_by }) };
				await setMandate(session.id, mandate);
				session.mandate = mandate;
				return { max_total: `$${(mandate.max_total_cents / 100).toFixed(2)}`, deliver_by };
			},
		}),

		search_web: tool({
			description:
				"Search other online shops (Channel3) for the same kind of product, to show the buyer what else is out there. You cannot buy these: those shops have no agent checkout, so the buyer opens them on the shop's site.",
			inputSchema: z.object({
				product_type: z
					.string()
					.min(2)
					.max(40)
					.describe(
						'Just the kind of product in 1-3 words, no colour, size or price, e.g. "kurta", "terracotta planter"',
					),
			}),
			execute: async ({ product_type }) => ({
				results: webSearchEnabled() ? await searchWeb(product_type) : [],
			}),
		}),

		search_stores: tool({
			description:
				"Search every AgentBaazar store's catalog. Returns products with their variants (color/size), prices and availability. Use the buyer's words as the query.",
			inputSchema: z.object({
				query: z.string().min(2).max(100),
				max_price: z
					.string()
					.regex(/^\d+(\.\d{1,2})?$/)
					.optional()
					.describe("Highest unit price in US dollars"),
			}),
			execute: async ({ query, max_price }) => {
				const all = await enabledStores();
				// One slow or broken store must not hide the others' results.
				const replies = (
					await Promise.allSettled(
						all.map((s) => cartClient(s).search(query, max_price ? toCents(max_price) : undefined)),
					)
				).flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
				const results: ProductView[] = replies.flatMap((r) => {
					if (!r.ok) return [];
					const { store, products } = r.body as import("@/src/platform/stores/cart-client").SearchResult;
					return products.slice(0, 3).map((p) => ({
						store_id: store.id,
						store_name: store.name,
						product_id: p.product_id,
						title: p.title,
						image_url: p.image_url,
						url: p.url,
						agent_checkout: (p as { agent_checkout?: boolean }).agent_checkout !== false,
						variants: p.variants.slice(0, 8).map((v) => ({
							variant_id: v.variant_id,
							label: [v.color, v.size].filter(Boolean).join(" / ") || v.title,
							price: usd(v.price)!,
							availability: v.availability,
						})),
					}));
				});
				return { results: results.slice(0, 8) };
			},
		}),

		create_cart: tool({
			description:
				"Open a cart at one store with the chosen variants. The buyer's name, email and shipping address are added automatically. The store answers with totals and any issues to resolve.",
			inputSchema: z.object({ store_id: z.string(), items: Items }),
			execute: async ({ store_id, items }) => {
				const store = await storeRef(store_id);
				const p = session.profile;
				const cart = asCart(
					await cartClient(store).create({
						items,
						customer: { name: p.name, email_address: p.email_address },
						shipping_address: p.shipping_address,
					}),
				);
				if (failed(cart)) return cart;
				await saveSessionCart(session.id, store_id, cart);
				return cartView(store_id, cart);
			},
		}),

		apply_fix: tool({
			description:
				"Apply one of the resolution options the store offered for an issue (by issue and option number from the cart). Some fixes need the buyer's OK first; the app asks them.",
			inputSchema: z.object({
				cart_id: z.string(),
				issue: z.number().int().min(0),
				option: z.number().int().min(0),
				value: z
					.string()
					.max(200)
					.optional()
					.describe("The buyer's answer, only for options that ask for information (e.g. allergy information)"),
			}),
			execute: async ({ cart_id, issue, option, value }) => {
				const sc = await sessionCart(session.id, cart_id);
				const opt = sc.cart.validation_issues?.[issue]?.resolution_options?.[option];
				if (!opt) return { error: `Cart ${cart_id} has no issue ${issue} option ${option}` };
				const patch = opt.metadata?.apply as CartPatch | undefined;
				if (!patch) return { error: `"${opt.label}" cannot be applied by the agent; explain it to the buyer.` };
				const cart = await put(cart_id, (c) => applyPatch(requestFromCart(c), patch, value));
				return failed(cart) ? cart : { ...cart, applied: opt.label };
			},
		}),

		change_items: tool({
			description: "Replace the items in a cart (e.g. change a quantity or add an item). Send the full item list.",
			inputSchema: z.object({ cart_id: z.string(), items: Items }),
			execute: async ({ cart_id, items }) => put(cart_id, (c) => ({ ...requestFromCart(c), items })),
		}),

		choose_shipping: tool({
			description: "Select one of the cart's shipping options by id (e.g. a faster one to meet a delivery date).",
			inputSchema: z.object({ cart_id: z.string(), option_id: z.string() }),
			execute: async ({ cart_id, option_id }) =>
				put(cart_id, (c) => {
					const chosen = c.available_shipping_options?.find((o) => o.id === option_id);
					if (!chosen) throw new Error(`No shipping option ${option_id}`);
					return { ...requestFromCart(c), available_shipping_options: [{ ...chosen, is_selected: true }] };
				}),
		}),

		get_offer: tool({
			description:
				"Ask the store for a discount on this cart (e.g. a first-order coupon). If it offers one, it is applied to the cart.",
			inputSchema: z.object({ cart_id: z.string() }),
			execute: async ({ cart_id }) => {
				const sc = await sessionCart(session.id, cart_id);
				const r = await cartClient(await storeRef(sc.storeId)).offer(cart_id, "first order");
				const body = r.body as { offer?: { code: string; description: string } | null; reason?: string };
				if (!r.ok || !body.offer) return { offer: null, reason: body.reason ?? "No offer available" };
				const code = body.offer.code;
				const cart = await put(cart_id, (c) => applyCoupon(requestFromCart(c), code));
				return { offer: body.offer, cart };
			},
		}),

		// No execute: the app shows an "Approve in PayPal" card and returns the outcome
		// once the buyer has approved (or declined) on PayPal's own page.
		request_paypal_approval: tool({
			description:
				"Ask the buyer to approve the payment in PayPal. Call only when the cart is ready_for_payment and within budget. The result arrives when the buyer has approved or declined.",
			inputSchema: z.object({ cart_id: z.string() }),
			outputSchema: z.object({ approved: z.boolean() }),
		}),

		complete_checkout: tool({
			description:
				"Place the order after the buyer approved in PayPal. PayPal authorizes the payment; the buyer is charged only when the store ships.",
			inputSchema: z.object({ cart_id: z.string() }),
			execute: async ({ cart_id }) => {
				const sc = await sessionCart(session.id, cart_id);
				const api = cartClient(await storeRef(sc.storeId));
				// The store's GET shows the payer once PayPal confirmed the approval.
				const current = asCart(await api.get(cart_id));
				if (failed(current)) return current;
				const token = current.payment_method?.token;
				const payerId = current.payment_method?.payer_id;
				if (current.status !== "COMPLETED" && (!token || !payerId))
					return { error: "The buyer has not approved this payment in PayPal yet." };
				const done =
					current.status === "COMPLETED"
						? current
						: asCart(await api.checkout(cart_id, { payment_method: { type: "paypal", token, payer_id: payerId } }));
				if (failed(done)) return done;
				await saveSessionCart(session.id, sc.storeId, done, "completed");
				return {
					...cartView(sc.storeId, done),
					note: "Payment authorized in PayPal. The buyer is charged only when the store ships.",
				};
			},
		}),

		order_status: tool({
			description: "Where is the order? Returns its payment status and any shipment tracking.",
			inputSchema: z.object({ cart_id: z.string() }),
			execute: async ({ cart_id }) => {
				const sc = await sessionCart(session.id, cart_id);
				const orderId = sc.cart.payment_confirmation?.merchant_order_number;
				if (!orderId) return { error: "This cart has not been checked out yet." };
				const r = await cartClient(await storeRef(sc.storeId)).order(orderId);
				return r.ok ? r.body : { error: (r.body as ApiError).message };
			},
		}),
	};
}

export type ShopperTools = ReturnType<typeof shopperTools>;
