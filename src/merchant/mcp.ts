/**
 * A store's own MCP server: the same cart, offer and order flow the Cart API serves,
 * as tools any MCP client (Claude Desktop, Cursor, ...) can call. Served stateless at
 * /api/stores/{store}/mcp.
 *
 * Tools call the merchant services directly as one caller, "mcp". The server is public,
 * so a cart id (CART-<ULID>, 80 random bits) is what lets a client read or change a cart,
 * just as it is for any Cart API caller. No money moves without the buyer: checkout
 * needs their approval on PayPal's own page, and the charge happens when the store ships.
 */
import { createMcpHandler } from "mcp-handler";
import { ZodError, z } from "zod";
import type { CartPatch } from "@/src/cart-spec/extensions";
import type { PayPalCart } from "@/src/cart-spec/schema";
import { log } from "@/src/log";
import { type ApiResult, HttpError } from "@/src/merchant/api/http";
import { AuthError, type CartCaller } from "@/src/merchant/auth/jwt-verify";
import * as repo from "@/src/merchant/cart/repo";
import { checkoutCart, createCart, getCart, updateCart } from "@/src/merchant/cart/service";
import { makeOffer, searchCatalog } from "@/src/merchant/discovery";
import { orderStatus } from "@/src/merchant/fulfillment";
import { PayPalError } from "@/src/merchant/paypal/http";
import { applyCoupon, applyPatch, requestFromCart } from "@/src/platform/agent/patch";
import { cartView } from "@/src/platform/agent/tools";

const Items = z
	.array(z.object({ variant_id: z.string().max(100), quantity: z.number().int().min(1).max(10) }))
	.min(1)
	.max(10);
const CartId = z.object({ cart_id: z.string().regex(/^CART-[A-Z0-9]{10,40}$/) });
const Dollars = z.string().regex(/^\d+(\.\d{1,2})?$/);

const text = (value: unknown, isError = false) => ({
	content: [{ type: "text" as const, text: JSON.stringify(value) }],
	...(isError && { isError }),
});

/** Run one tool call; merchant errors come back as text the model can act on. */
async function run(store: string, tool: string, fn: () => Promise<unknown>) {
	try {
		return text(await fn());
	} catch (e) {
		if (e instanceof HttpError)
			return text({ error: e.body.message, details: e.body.details?.map((d) => d.description) }, true);
		if (e instanceof ZodError) return text({ error: "Invalid request", details: e.issues.map((i) => i.message) }, true);
		if (e instanceof PayPalError) return text({ error: "PayPal could not complete the request" }, true);
		if (e instanceof AuthError) return text({ error: e.message }, true);
		// Message only: driver errors can carry query parameters (emails, addresses).
		log.error({ store, tool, err: (e as Error)?.message?.slice(0, 300) }, "mcp tool failed");
		return text({ error: "Unexpected error" }, true);
	}
}

const body = <T>(r: ApiResult) => {
	if (r.status >= 400) {
		const b = r.body as { message?: string };
		throw new HttpError(r.status, { name: "REQUEST_FAILED", message: b.message ?? `HTTP ${r.status}` });
	}
	return r.body as T;
};

/** The cart as the model sees it, plus where the buyer approves the payment. */
function view(store: string, c: PayPalCart) {
	const v = cartView(store, c);
	const pm = c.payment_method;
	return {
		...v,
		...(v.ready_for_payment &&
			!v.order && {
				payment: {
					approve_url: pm?.approval_url,
					buyer_approved: Boolean(pm?.payer_id),
					next: pm?.payer_id
						? "The buyer approved in PayPal: call checkout to place the order."
						: "Give the buyer approve_url to approve the payment in PayPal, then call checkout.",
				},
			}),
	};
}

export function storeMcp(m: repo.Merchant) {
	const caller: CartCaller = { payload: {}, merchantId: m.id, subject: "mcp" };
	// Read the merchant fresh per call, so policy changes apply without a restart.
	const merchant = async () => {
		const row = await repo.getMerchant(m.id);
		if (!row) throw new HttpError(404, { name: "STORE_NOT_FOUND", message: `Store '${m.id}' does not exist` });
		return row;
	};
	const cart = async (cartId: string) => body<PayPalCart>(await getCart(await merchant(), cartId, caller));
	const put = async (cartId: string, next: (c: PayPalCart) => ReturnType<typeof requestFromCart>) =>
		view(m.id, body<PayPalCart>(await updateCart(await merchant(), cartId, next(await cart(cartId)), caller)));

	return createMcpHandler(
		(server) => {
			server.registerTool(
				"search_products",
				{
					title: "Search products",
					description: `Search ${m.name}'s catalog. Returns products with their variants (colour, size), prices and stock.`,
					inputSchema: z.object({
						query: z.string().min(2).max(100),
						max_price: Dollars.optional().describe('Highest unit price in US dollars, e.g. "40.00"'),
					}),
					annotations: { readOnlyHint: true },
				},
				({ query, max_price }) =>
					run(m.id, "search_products", async () => {
						const params = new URLSearchParams({ q: query, limit: "8" });
						if (max_price) params.set("max_price", max_price);
						return body(await searchCatalog(m.id, params));
					}),
			);

			server.registerTool(
				"create_cart",
				{
					title: "Create cart",
					description:
						"Open a cart with the chosen variants, for delivery to the buyer's US address. The store answers with totals, shipping options and any issues to resolve.",
					inputSchema: z.object({
						items: Items,
						buyer: z.object({
							given_name: z.string().min(1).max(60),
							surname: z.string().min(1).max(60),
							email: z.email().max(120),
							address_line_1: z.string().min(1).max(200),
							address_line_2: z.string().max(200).optional(),
							city: z.string().min(1).max(100),
							state: z
								.string()
								.regex(/^[A-Z]{2}$/)
								.describe('Two-letter state code, e.g. "TX"'),
							postal_code: z.string().regex(/^\d{5}(-\d{4})?$/),
						}),
					}),
				},
				({ items, buyer: b }) =>
					run(m.id, "create_cart", async () => {
						const c = body<PayPalCart>(
							await createCart(
								await merchant(),
								{
									items,
									customer: { name: { given_name: b.given_name, surname: b.surname }, email_address: b.email },
									shipping_address: {
										address_line_1: b.address_line_1,
										...(b.address_line_2 && { address_line_2: b.address_line_2 }),
										admin_area_2: b.city,
										admin_area_1: b.state,
										postal_code: b.postal_code,
										country_code: "US",
									},
								},
								caller,
							),
						);
						return view(m.id, c);
					}),
			);

			server.registerTool(
				"get_cart",
				{
					title: "Get cart",
					description: "The cart's items, totals, issues, and whether the buyer has approved the payment in PayPal.",
					inputSchema: CartId,
					annotations: { readOnlyHint: true },
				},
				({ cart_id }) => run(m.id, "get_cart", async () => view(m.id, await cart(cart_id))),
			);

			server.registerTool(
				"apply_fix",
				{
					title: "Apply a fix",
					description:
						"Apply one of the resolution options the store offered for an issue, by issue and option number from the cart. Ask the buyer first if the option changes the item or the price.",
					inputSchema: CartId.extend({
						issue: z.number().int().min(0),
						option: z.number().int().min(0),
						value: z
							.string()
							.max(200)
							.optional()
							.describe("The buyer's answer, only for options that ask for information"),
					}),
				},
				({ cart_id, issue, option, value }) =>
					run(m.id, "apply_fix", async () => {
						const opt = (await cart(cart_id)).validation_issues?.[issue]?.resolution_options?.[option];
						if (!opt) return { error: `The cart has no issue ${issue} option ${option}` };
						const patch = opt.metadata?.apply as CartPatch | undefined;
						if (!patch) return { error: `"${opt.label}" cannot be applied automatically; explain it to the buyer.` };
						return {
							applied: opt.label,
							cart: await put(cart_id, (c) => applyPatch(requestFromCart(c), patch, value)),
						};
					}),
			);

			server.registerTool(
				"change_items",
				{
					title: "Change items",
					description: "Replace the cart's items (change a quantity, add or remove an item). Send the full item list.",
					inputSchema: CartId.extend({ items: Items }),
				},
				({ cart_id, items }) =>
					run(m.id, "change_items", () => put(cart_id, (c) => ({ ...requestFromCart(c), items }))),
			);

			server.registerTool(
				"choose_shipping",
				{
					title: "Choose shipping",
					description: "Select one of the cart's shipping options by id.",
					inputSchema: CartId.extend({ option_id: z.string().max(100) }),
				},
				({ cart_id, option_id }) =>
					run(m.id, "choose_shipping", () =>
						put(cart_id, (c) => {
							const chosen = c.available_shipping_options?.find((o) => o.id === option_id);
							if (!chosen)
								throw new HttpError(400, { name: "INVALID_REQUEST", message: `No shipping option ${option_id}` });
							return { ...requestFromCart(c), available_shipping_options: [{ ...chosen, is_selected: true }] };
						}),
					),
			);

			server.registerTool(
				"request_offer",
				{
					title: "Ask for a discount",
					description:
						"Ask the store for a discount on this cart (e.g. a first-order coupon). If it offers one, it is applied.",
					inputSchema: CartId,
				},
				({ cart_id }) =>
					run(m.id, "request_offer", async () => {
						const r = body<{ offer: { code: string } | null; reason?: string }>(
							await makeOffer(await merchant(), { cart_id, reason: "first order" }, caller),
						);
						if (!r.offer) return { offer: null, reason: r.reason ?? "No offer available" };
						const code = r.offer.code;
						return { offer: r.offer, cart: await put(cart_id, (c) => applyCoupon(requestFromCart(c), code)) };
					}),
			);

			server.registerTool(
				"checkout",
				{
					title: "Place the order",
					description:
						"Place the order once the buyer has approved the payment in PayPal (get_cart shows buyer_approved). PayPal authorizes the payment; the buyer is charged only when the store ships.",
					inputSchema: CartId,
				},
				({ cart_id }) =>
					run(m.id, "checkout", async () => {
						const c = await cart(cart_id);
						if (c.status === "COMPLETED") return view(m.id, c);
						const { token, payer_id } = c.payment_method ?? {};
						if (!token || !payer_id)
							return { error: "The buyer has not approved this payment in PayPal yet.", ...view(m.id, c) };
						const done = body<PayPalCart>(
							await checkoutCart(
								await merchant(),
								cart_id,
								{ payment_method: { type: "paypal", token, payer_id } },
								caller,
							),
						);
						return {
							...view(m.id, done),
							note: "Payment authorized in PayPal. The buyer is charged only when the store ships.",
						};
					}),
			);

			server.registerTool(
				"order_status",
				{
					title: "Order status",
					description: "Payment status and shipment tracking for a checked-out cart.",
					inputSchema: CartId,
					annotations: { readOnlyHint: true },
				},
				({ cart_id }) =>
					run(m.id, "order_status", async () => {
						const orderId = (await cart(cart_id)).payment_confirmation?.merchant_order_number;
						if (!orderId) return { error: "This cart has not been checked out yet." };
						return body(await orderStatus(await merchant(), orderId, caller));
					}),
			);
		},
		{
			serverInfo: { name: `agentbaazar-${m.id}`, version: "1.0.0" },
			instructions: `You are shopping at ${m.name}, an AgentBaazar store. Flow: search_products, create_cart, resolve any issues (apply_fix), optionally request_offer, then give the buyer the payment.approve_url to approve in PayPal; once get_cart shows buyer_approved, call checkout. Never change the buyer's chosen size or colour without asking. Payment is authorized at checkout and captured only when the store ships.`,
		},
	);
}
