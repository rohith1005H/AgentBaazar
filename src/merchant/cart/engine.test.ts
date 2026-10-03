import { describe, expect, it } from "vitest";
import { type CartRequest, PayPalCart, type ValidationIssue } from "@/src/cart-spec/schema";
import type { MerchantPolicy } from "@/src/db/schema";
import { assertTotals } from "@/src/merchant/paypal/orders";
import { type EvaluateInput, evaluateCart } from "./engine";
import { toCents } from "./money";
import type { CatalogVariant, CouponRow } from "./types";

// ---- fixtures ------------------------------------------------------------

const NOW = new Date("2026-10-05T12:00:00Z");

const policy = (over: Partial<MerchantPolicy> = {}): MerchantPolicy => ({
	currency: "USD",
	shippingOptions: [
		{ id: "STANDARD", name: "Standard (5 days)", baseCents: 599, perKgCents: 100, etaDays: 5, regions: ["*"] },
		{ id: "EXPRESS", name: "Express (2 days)", baseCents: 1499, perKgCents: 200, etaDays: 2, regions: ["*"] },
	],
	taxRates: { TX: 0.0825, CA: 0.0725, "*": 0.06 },
	regionsServed: ["*"],
	poBoxAllowedForFragile: false,
	coupons: { firstOrderPct: 10, maxTotalPct: 15, minSubtotalCents: 2500, expiresMinutes: 30 },
	...over,
});

const v = (over: Partial<CatalogVariant> & { id: string }): CatalogVariant => ({
	productId: "kurta-001",
	groupId: "kurta-001",
	title: `Kurta ${over.id}`,
	description: "Handloom cotton kurta",
	url: `https://agentbaazar.test/m/patel/p/${over.id}`,
	priceCents: 3900,
	salePriceCents: null,
	currency: "USD",
	color: "blue",
	size: "M",
	weightG: 350,
	availability: "in_stock",
	stockQty: 10,
	restockEta: null,
	fragile: false,
	requiresFields: [],
	agentCheckout: true,
	...over,
});

const catalogOf = (...vs: CatalogVariant[]) => new Map(vs.map((x) => [x.id, x]));

const AUSTIN = {
	address_line_1: "100 Congress Ave",
	admin_area_2: "Austin",
	admin_area_1: "TX",
	postal_code: "78701",
	country_code: "US",
};

function run(over: Partial<EvaluateInput> & { request: CartRequest }) {
	const input: EvaluateInput = {
		catalog: catalogOf(v({ id: "BLUE-M" })),
		policy: policy(),
		coupons: new Map(),
		cartId: "CART-TEST",
		now: NOW,
		...over,
	};
	const out = evaluateCart(input);
	// every result must be a spec-conformant cart and its totals must add up
	PayPalCart.parse(out.cart);
	assertTotals(out.totals);
	expect(toCents(out.cart.totals!.total.value)).toBe(out.totals.totalCents);
	return out;
}

const issue = (issues: ValidationIssue[] | undefined, specific: string) =>
	issues?.find((i) => (i.context as { specific_issue?: string } | undefined)?.specific_issue === specific);

// ---- happy path ------------------------------------------------------------

describe("valid cart", () => {
	it("prices a clean cart: cheapest shipping, state tax, exact totals", () => {
		const out = run({ request: { items: [{ variant_id: "BLUE-M", quantity: 2 }], shipping_address: AUSTIN } });
		expect(out.valid).toBe(true);
		expect(out.cart.status).toBe("CREATED");
		expect(out.cart.validation_status).toBe("VALID");
		expect(out.cart.validation_issues).toEqual([]);
		// 2 x 39.00
		expect(out.totals.itemTotalCents).toBe(7800);
		// standard: 5.99 + 1.00 x ceil(0.7 kg)
		expect(out.totals.shippingCents).toBe(699);
		// TX 8.25% of 78.00 = 6.435 -> 6.44 (half up)
		expect(out.totals.taxCents).toBe(644);
		expect(out.cart.totals?.total.value).toBe("91.43");
		expect(out.cart.available_shipping_options?.find((o) => o.is_selected)?.id).toBe("STANDARD");
		expect(out.cart.available_shipping_options?.[0].estimated_delivery).toBe("2026-10-10");
		expect(out.lines).toEqual([
			{
				sku: "BLUE-M",
				name: "Kurta BLUE-M",
				quantity: 2,
				unitCents: 3900,
				url: "https://agentbaazar.test/m/patel/p/BLUE-M",
			},
		]);
		expect(out.shipTo?.state).toBe("TX");
	});

	it("echoes catalog data, never caller-supplied names", () => {
		const out = run({
			request: { items: [{ variant_id: "BLUE-M", quantity: 1, name: "Free TV" }], shipping_address: AUSTIN },
		});
		const item = out.cart.items?.[0];
		expect(item?.name).toBe("Kurta BLUE-M");
		expect(item?.price).toEqual({ currency_code: "USD", value: "39.00" });
		expect(item?.selected_attributes).toEqual([
			{ name: "Color", value: "blue" },
			{ name: "Size", value: "M" },
		]);
	});

	it("uses the sale price when one is set", () => {
		const out = run({
			catalog: catalogOf(v({ id: "BLUE-M", salePriceCents: 2900 })),
			request: { items: [{ variant_id: "BLUE-M", quantity: 1 }], shipping_address: AUSTIN },
		});
		expect(out.totals.itemTotalCents).toBe(2900);
	});

	it("keeps the caller's shipping selection when still offered", () => {
		const out = run({
			request: {
				items: [{ variant_id: "BLUE-M", quantity: 1 }],
				shipping_address: AUSTIN,
				available_shipping_options: [
					{ id: "EXPRESS", name: "x", price: { currency_code: "USD", value: "0.00" }, is_selected: true },
				],
			},
		});
		const selected = out.cart.available_shipping_options?.find((o) => o.is_selected);
		expect(selected?.id).toBe("EXPRESS");
		// price comes from policy, not from the caller
		expect(selected?.price.value).toBe("16.99");
	});

	it("merges duplicate lines for the same variant", () => {
		const out = run({
			request: {
				items: [
					{ variant_id: "BLUE-M", quantity: 1 },
					{ variant_id: "BLUE-M", quantity: 2 },
				],
				shipping_address: AUSTIN,
			},
		});
		expect(out.cart.items).toHaveLength(1);
		expect(out.cart.items?.[0].quantity).toBe(3);
	});

	it("totals always add up across random carts", () => {
		let seed = 42;
		const rnd = (n: number) => {
			seed = (seed * 1103515245 + 12345) % 2 ** 31;
			return seed % n;
		};
		const states = ["TX", "CA", "NY", "WA", "FL"];
		for (let i = 0; i < 60; i++) {
			const variants = Array.from({ length: 1 + rnd(4) }, (_, k) =>
				v({ id: `V${k}`, productId: `P${k}`, priceCents: 1 + rnd(20_000), weightG: rnd(5000), stockQty: 100 }),
			);
			const out = run({
				catalog: catalogOf(...variants),
				policy: policy({ coupons: { firstOrderPct: 10, maxTotalPct: 15, minSubtotalCents: 0, expiresMinutes: 30 } }),
				coupons: new Map([["SAVE20", coupon({ code: "SAVE20", value: 20 })]]),
				request: {
					items: variants.map((x) => ({ variant_id: x.id, quantity: 1 + rnd(5) })),
					shipping_address: { ...AUSTIN, admin_area_1: states[rnd(states.length)] },
					coupons: rnd(2) ? [{ code: "SAVE20", action: "APPLY" }] : [],
				},
			});
			expect(out.valid).toBe(true);
			// discount never exceeds the 15% cap
			expect(out.totals.discountCents).toBeLessThanOrEqual(Math.round(out.totals.itemTotalCents * 0.15));
		}
	});
});

// ---- inventory -------------------------------------------------------------

describe("inventory issues", () => {
	const catalog = catalogOf(
		v({ id: "BLUE-M", stockQty: 0, availability: "out_of_stock", restockEta: "2026-10-20" }),
		v({ id: "INDIGO-M", color: "indigo" }),
		v({ id: "BLUE-L", size: "L" }),
		v({ id: "GOLD-M", color: "gold", priceCents: 4900 }),
	);

	it("out of stock: suggests same-size same-price variant first, auto-applicable", () => {
		const out = run({ catalog, request: { items: [{ variant_id: "BLUE-M", quantity: 1 }], shipping_address: AUSTIN } });
		expect(out.valid).toBe(false);
		expect(out.cart.status).toBe("INCOMPLETE");
		expect(out.cart.validation_status).toBe("INVALID");
		const oos = issue(out.cart.validation_issues, "ITEM_OUT_OF_STOCK");
		expect(oos?.code).toBe("INVENTORY_ISSUE");
		expect(oos?.context).toMatchObject({
			available_quantity: 0,
			requested_quantity: 1,
			restock_date: "2026-10-20T00:00:00Z",
		});
		expect(oos?.context?.suggested_alternatives).toEqual(["INDIGO-M", "GOLD-M", "BLUE-L"]);
		const [first, second] = oos?.resolution_options ?? [];
		expect(first.action).toBe("CHOOSE_DIFFERENT_VARIANT");
		expect(first.metadata).toMatchObject({
			auto_applicable: true,
			apply: { op: "replace_variant", variant_id: "BLUE-M", with_variant_id: "INDIGO-M" },
		});
		// pricier alternative is never auto-applicable
		expect(second.metadata).toMatchObject({ auto_applicable: false, cost_impact: "+$10.00" });
		expect(oos?.resolution_options?.map((o) => o.action)).toEqual([
			"CHOOSE_DIFFERENT_VARIANT",
			"CHOOSE_DIFFERENT_VARIANT",
			"CHOOSE_DIFFERENT_VARIANT",
			"WAIT_FOR_RESTOCK",
			"REMOVE_ITEM",
		]);
		// unavailable line is not charged
		expect(out.totals.itemTotalCents).toBe(0);
		expect(out.lines).toEqual([]);
	});

	it("applying the suggested patch produces a valid cart", () => {
		const out = run({
			catalog,
			request: { items: [{ variant_id: "INDIGO-M", quantity: 1 }], shipping_address: AUSTIN },
		});
		expect(out.valid).toBe(true);
	});

	it("insufficient stock: offers the available quantity", () => {
		const out = run({
			catalog: catalogOf(v({ id: "BLUE-M", stockQty: 2 })),
			request: { items: [{ variant_id: "BLUE-M", quantity: 5 }], shipping_address: AUSTIN },
		});
		const low = issue(out.cart.validation_issues, "INSUFFICIENT_INVENTORY");
		expect(low?.context).toMatchObject({ available_quantity: 2, requested_quantity: 5 });
		expect(low?.resolution_options?.[0]).toMatchObject({
			action: "MODIFY_CART",
			metadata: { auto_applicable: true, apply: { op: "set_quantity", variant_id: "BLUE-M", quantity: 2 } },
		});
	});

	it("back-order: blocks until the agent accepts via custom option", () => {
		const catalog = catalogOf(
			v({ id: "BEANS", productId: "beans", availability: "backorder", stockQty: 0, restockEta: "2026-11-01" }),
		);
		const blocked = run({
			catalog,
			request: { items: [{ variant_id: "BEANS", quantity: 1 }], shipping_address: AUSTIN },
		});
		const bo = issue(blocked.cart.validation_issues, "BACK_ORDERED");
		expect(bo?.context?.estimated_ship_date).toBe("2026-11-01T00:00:00Z");
		const accept = bo?.resolution_options?.[0];
		expect(accept?.action).toBe("ACCEPT_BACK_ORDER");
		expect(accept?.metadata?.apply).toEqual({
			op: "add_custom_option",
			variant_id: "BEANS",
			option: { name: "accept_back_order", value: "true" },
		});

		const ok = run({
			catalog,
			request: {
				items: [{ variant_id: "BEANS", quantity: 1, custom_options: [{ name: "accept_back_order", value: "true" }] }],
				shipping_address: AUSTIN,
			},
		});
		expect(ok.valid).toBe(true);
	});

	it("feed opt-out (is_eligible_checkout=false): redirect to the merchant", () => {
		const out = run({
			catalog: catalogOf(v({ id: "BLUE-M", agentCheckout: false })),
			request: { items: [{ variant_id: "BLUE-M", quantity: 1 }], shipping_address: AUSTIN },
		});
		const issue0 = out.cart.validation_issues?.[0];
		expect(issue0?.code).toBe("BUSINESS_RULE_ERROR");
		expect(issue0?.resolution_options?.[0]).toMatchObject({
			action: "REDIRECT_TO_MERCHANT",
			url: "https://agentbaazar.test/m/patel/p/BLUE-M",
		});
		expect(out.lines).toEqual([]);
	});

	it("unknown variant: data error with remove option", () => {
		const out = run({ request: { items: [{ variant_id: "NOPE", quantity: 1 }], shipping_address: AUSTIN } });
		const nf = issue(out.cart.validation_issues, "ITEM_NOT_FOUND");
		expect(nf?.code).toBe("DATA_ERROR");
		expect(nf?.resolution_options?.[0].metadata?.apply).toEqual({ op: "remove_item", variant_id: "NOPE" });
	});
});

// ---- pricing ---------------------------------------------------------------

describe("price changes", () => {
	it("flags an increase and requires explicit acceptance", () => {
		const out = run({
			request: {
				items: [{ variant_id: "BLUE-M", quantity: 1, price: { currency_code: "USD", value: "35.00" } }],
				shipping_address: AUSTIN,
			},
		});
		const pm = issue(out.cart.validation_issues, "PRICE_MISMATCH");
		expect(pm?.context).toMatchObject({ original_price: "35.00", current_price: "39.00", price_increase: "4.00" });
		expect(pm?.resolution_options?.[0]).toMatchObject({
			action: "ACCEPT_NEW_PRICE",
			metadata: { auto_applicable: false, cost_impact: "+$4.00" },
		});
		// the buyer sees what they would pay
		expect(out.totals.itemTotalCents).toBe(3900);
		expect(out.valid).toBe(false);
	});

	it("a decrease is auto-applicable", () => {
		const out = run({
			request: {
				items: [{ variant_id: "BLUE-M", quantity: 1, price: { currency_code: "USD", value: "45.00" } }],
				shipping_address: AUSTIN,
			},
		});
		const pm = issue(out.cart.validation_issues, "PRICE_MISMATCH");
		expect(pm?.context?.price_decrease).toBe("6.00");
		expect(pm?.resolution_options?.[0].metadata?.auto_applicable).toBe(true);
	});

	it("quoting the current price is valid", () => {
		const out = run({
			request: {
				items: [{ variant_id: "BLUE-M", quantity: 1, price: { currency_code: "USD", value: "39.00" } }],
				shipping_address: AUSTIN,
			},
		});
		expect(out.valid).toBe(true);
	});
});

// ---- address ---------------------------------------------------------------

describe("shipping address", () => {
	const items = [{ variant_id: "BLUE-M", quantity: 1 }];

	it("missing address needs more information, not a hard failure", () => {
		const out = run({ request: { items } });
		expect(out.cart.validation_status).toBe("REQUIRES_ADDITIONAL_INFORMATION");
		expect(issue(out.cart.validation_issues, "MISSING_SHIPPING_ADDRESS")?.type).toBe("MISSING_FIELD");
		expect(out.cart.available_shipping_options).toEqual([]);
		expect(out.totals.taxCents).toBe(0);
	});

	it("invalid address lists what is wrong", () => {
		const out = run({
			request: {
				items,
				shipping_address: {
					address_line_1: "",
					admin_area_2: "Austin",
					admin_area_1: "ZZ",
					postal_code: "7870",
					country_code: "US",
				},
			},
		});
		const bad = issue(out.cart.validation_issues, "SHIPPING_ADDRESS_INVALID");
		expect(bad?.context?.validation_failures).toEqual(["missing_street", "invalid_state", "invalid_postal_code"]);
		expect(out.cart.validation_status).toBe("INVALID");
	});

	it("outside the US is restricted", () => {
		const out = run({ request: { items, shipping_address: { ...AUSTIN, country_code: "IN" } } });
		expect(issue(out.cart.validation_issues, "INTERNATIONAL_SHIPPING_RESTRICTED")?.context).toMatchObject({
			destination_country: "IN",
			supported_countries: ["US"],
		});
	});

	it("unserved state is a shipping zone issue", () => {
		const out = run({
			policy: policy({ regionsServed: ["TX", "CA"] }),
			request: { items, shipping_address: { ...AUSTIN, admin_area_1: "HI" } },
		});
		expect(issue(out.cart.validation_issues, "SHIPPING_ZONE_NOT_COVERED")?.context?.restricted_region).toBe("HI");
	});

	it("fragile items cannot go to a PO box, other items can", () => {
		const pobox = { ...AUSTIN, address_line_1: "P.O. Box 1234" };
		const fragile = run({
			catalog: catalogOf(v({ id: "VASE", productId: "vase", fragile: true, priceCents: 6500 })),
			request: { items: [{ variant_id: "VASE", quantity: 1 }], shipping_address: pobox },
		});
		const po = issue(fragile.cart.validation_issues, "SHIPPING_TO_PO_BOX_NOT_ALLOWED");
		expect(po?.context).toMatchObject({ restricted_items: ["VASE"], po_box_detected: true });
		expect(po?.resolution_options?.map((o) => o.action)).toEqual(["UPDATE_ADDRESS", "REMOVE_ITEM"]);

		const plain = run({ request: { items, shipping_address: pobox } });
		expect(plain.valid).toBe(true);
	});
});

// ---- checkout fields ---------------------------------------------------------

describe("checkout fields", () => {
	const catalog = catalogOf(v({ id: "TOFFEE", productId: "toffee", requiresFields: ["ALLERGY_INFORMATION"] }));
	const base = { items: [{ variant_id: "TOFFEE", quantity: 1 }], shipping_address: AUSTIN };

	it("required field missing -> PENDING and MISSING_FIELD", () => {
		const out = run({ catalog, request: base });
		expect(out.cart.validation_status).toBe("REQUIRES_ADDITIONAL_INFORMATION");
		expect(out.cart.checkout_fields?.[0]).toMatchObject({ type: "ALLERGY_INFORMATION", status: "PENDING" });
		const f = issue(out.cart.validation_issues, "MISSING_CHECKOUT_FIELDS");
		expect(f?.resolution_options?.[0].metadata?.apply).toMatchObject({
			op: "set_checkout_field",
			type: "ALLERGY_INFORMATION",
		});
	});

	it("invalid value -> REJECTED", () => {
		const out = run({
			catalog,
			request: {
				...base,
				checkout_fields: [
					{
						type: "ALLERGY_INFORMATION",
						status: "COMPLETED",
						value: { type: "ALLERGY_INFORMATION", allergies: "nuts" },
					},
				],
			},
		});
		expect(out.cart.checkout_fields?.[0].status).toBe("REJECTED");
		expect(out.cart.validation_status).toBe("INVALID");
	});

	it("valid value -> COMPLETED and a valid cart", () => {
		const out = run({
			catalog,
			request: {
				...base,
				checkout_fields: [
					{ type: "ALLERGY_INFORMATION", status: "PENDING", value: { type: "ALLERGY_INFORMATION", allergies: [] } },
				],
			},
		});
		expect(out.cart.checkout_fields?.[0].status).toBe("COMPLETED");
		expect(out.valid).toBe(true);
	});

	it("keeps optional fields the caller supplied", () => {
		const out = run({
			request: {
				items: [{ variant_id: "BLUE-M", quantity: 1 }],
				shipping_address: AUSTIN,
				checkout_fields: [
					{
						type: "DELIVERY_INSTRUCTIONS",
						status: "PENDING",
						value: { type: "DELIVERY_INSTRUCTIONS", instructions: "Leave at door" },
					},
				],
			},
		});
		expect(out.cart.checkout_fields).toEqual([
			{
				type: "DELIVERY_INSTRUCTIONS",
				status: "COMPLETED",
				value: { type: "DELIVERY_INSTRUCTIONS", instructions: "Leave at door" },
			},
		]);
		expect(out.valid).toBe(true);
	});
});

// ---- coupons -----------------------------------------------------------------

const coupon = (over: Partial<CouponRow> & { code: string }): CouponRow => ({
	kind: "percent",
	value: 10,
	minSubtotalCents: 0,
	maxUses: 1,
	used: 0,
	expiresAt: null,
	issuedToCartId: null,
	description: null,
	...over,
});

describe("coupons", () => {
	const items = [{ variant_id: "BLUE-M", quantity: 2 }];

	it("applies a percent coupon to the subtotal before tax", () => {
		const out = run({
			coupons: new Map([["WELCOME10-AB", coupon({ code: "WELCOME10-AB", issuedToCartId: "CART-TEST" })]]),
			request: { items, shipping_address: AUSTIN, coupons: [{ code: "welcome10-ab", action: "APPLY" }] },
		});
		expect(out.valid).toBe(true);
		expect(out.totals.discountCents).toBe(780);
		expect(out.cart.applied_coupons?.[0]).toMatchObject({ code: "WELCOME10-AB", discount_amount: { value: "7.80" } });
		// tax on 78.00 - 7.80 = 70.20 -> 5.79
		expect(out.totals.taxCents).toBe(579);
	});

	it("caps total discount at the policy maximum", () => {
		const out = run({
			coupons: new Map([
				["A", coupon({ code: "A", value: 10 })],
				["B", coupon({ code: "B", value: 10 })],
			]),
			request: {
				items,
				shipping_address: AUSTIN,
				coupons: [
					{ code: "A", action: "APPLY" },
					{ code: "B", action: "APPLY" },
				],
			},
		});
		// 15% of 78.00
		expect(out.totals.discountCents).toBe(1170);
	});

	it("REMOVE wins over APPLY", () => {
		const out = run({
			coupons: new Map([["A", coupon({ code: "A" })]]),
			request: {
				items,
				shipping_address: AUSTIN,
				coupons: [
					{ code: "A", action: "APPLY" },
					{ code: "A", action: "REMOVE" },
				],
			},
		});
		expect(out.totals.discountCents).toBe(0);
		expect(out.cart.applied_coupons).toEqual([]);
	});

	it.each([
		["unknown", undefined, undefined],
		["expired", coupon({ code: "X", expiresAt: new Date("2026-10-01T00:00:00Z") }), "DISCOUNT_EXPIRED"],
		["used up", coupon({ code: "X", used: 1 }), "DISCOUNT_USAGE_LIMIT_EXCEEDED"],
		["another cart's offer", coupon({ code: "X", issuedToCartId: "CART-OTHER" }), "DISCOUNT_CUSTOMER_INELIGIBLE"],
		["minimum not met", coupon({ code: "X", minSubtotalCents: 50_000 }), "DISCOUNT_MINIMUM_NOT_MET"],
	])("rejects a %s coupon with a removable issue", (_, row, specific) => {
		const out = run({
			coupons: row ? new Map([["X", row]]) : new Map(),
			request: { items, shipping_address: AUSTIN, coupons: [{ code: "X", action: "APPLY" }] },
		});
		const bad = out.cart.validation_issues?.find((i) => i.field === "coupons");
		expect(bad?.code).toBe("PRICING_ERROR");
		expect((bad?.context as { specific_issue?: string } | undefined)?.specific_issue).toBe(specific);
		expect(bad?.resolution_options?.[0].metadata?.apply).toEqual({ op: "remove_coupon", code: "X" });
		expect(out.totals.discountCents).toBe(0);
	});

	it("free-shipping coupon and threshold become a shipping discount", () => {
		const viaCoupon = run({
			coupons: new Map([["SHIPFREE", coupon({ code: "SHIPFREE", kind: "free_shipping", value: 0 })]]),
			request: { items, shipping_address: AUSTIN, coupons: [{ code: "SHIPFREE", action: "APPLY" }] },
		});
		expect(viaCoupon.totals.shippingDiscountCents).toBe(viaCoupon.totals.shippingCents);

		const viaThreshold = run({
			policy: policy({
				coupons: {
					firstOrderPct: 10,
					maxTotalPct: 15,
					minSubtotalCents: 0,
					expiresMinutes: 30,
					freeShippingOverCents: 7500,
				},
			}),
			request: { items, shipping_address: AUSTIN },
		});
		expect(viaThreshold.cart.totals?.shipping_discount?.value).toBe(viaThreshold.cart.totals?.shipping?.value);
	});
});

// ---- store state -------------------------------------------------------------

describe("store state", () => {
	it("maintenance mode blocks with RETRY_LATER", () => {
		const out = run({
			policy: policy({ maintenance: true }),
			request: { items: [{ variant_id: "BLUE-M", quantity: 1 }], shipping_address: AUSTIN },
		});
		const closed = issue(out.cart.validation_issues, "STORE_TEMPORARILY_CLOSED");
		expect(closed?.code).toBe("BUSINESS_RULE_ERROR");
		expect(closed?.resolution_options?.[0].action).toBe("RETRY_LATER");
		expect(out.valid).toBe(false);
	});
});
