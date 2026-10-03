import { describe, expect, it } from "vitest";
import { CartRequest, type PayPalCart } from "@/src/cart-spec/schema";
import { applyCoupon, applyPatch, requestFromCart } from "./patch";

const usd = (value: string) => ({ currency_code: "USD", value });

const response: PayPalCart = {
	id: "CART-01ABC",
	status: "INCOMPLETE",
	validation_status: "INVALID",
	validation_issues: [],
	items: [
		{ variant_id: "BLUE-M", quantity: 1, name: "Kurta", price: usd("39.00"), item_url: "https://x.test/p" },
		{ variant_id: "TOFFEE", quantity: 2, price: usd("12.00"), gift_options: { is_gift: true } },
	],
	customer: { email_address: "rohan@example.com" },
	shipping_address: {
		address_line_1: "1 Main",
		admin_area_2: "Austin",
		admin_area_1: "TX",
		postal_code: "78701",
		country_code: "US",
	},
	available_shipping_options: [
		{ id: "STANDARD", name: "Std", price: usd("5.99"), is_selected: false },
		{ id: "EXPRESS", name: "Exp", price: usd("14.99"), is_selected: true },
	],
	applied_coupons: [{ code: "WELCOME10-AB12", discount_amount: usd("3.90") }],
	checkout_fields: [
		{ type: "ALLERGY_INFORMATION", status: "COMPLETED", value: { type: "ALLERGY_INFORMATION", allergies: [] } },
		{ type: "GIFT_MESSAGE", status: "PENDING" },
	],
	totals: { total: usd("50.00") },
	payment_method: { type: "paypal", token: "EC-1" },
};

describe("requestFromCart", () => {
	const req = requestFromCart(response);

	it("keeps only writable fields and is a valid Cart API request", () => {
		expect(CartRequest.parse(req)).toEqual(req);
		expect(req).not.toHaveProperty("totals");
		expect(req).not.toHaveProperty("validation_issues");
		expect(req.items[0]).toEqual({ variant_id: "BLUE-M", quantity: 1, price: usd("39.00") });
	});

	it("carries the shipping selection, completed fields and applied coupons forward", () => {
		expect(req.available_shipping_options?.map((o) => o.id)).toEqual(["EXPRESS"]);
		expect(req.checkout_fields?.map((f) => f.type)).toEqual(["ALLERGY_INFORMATION"]);
		expect(req.coupons).toEqual([{ code: "WELCOME10-AB12", action: "APPLY" }]);
	});
});

describe("applyPatch", () => {
	const base = requestFromCart(response);

	it("replace_variant swaps the line and drops the stale price quote", () => {
		const r = applyPatch(base, { op: "replace_variant", variant_id: "BLUE-M", with_variant_id: "INDIGO-M" });
		expect(r.items.map((i) => i.variant_id)).toEqual(["TOFFEE", "INDIGO-M"]);
		expect(r.items[1]).toEqual({ variant_id: "INDIGO-M", quantity: 1 });
	});

	it("replace_variant merges into an existing line", () => {
		const r = applyPatch(base, { op: "replace_variant", variant_id: "BLUE-M", with_variant_id: "TOFFEE" });
		expect(r.items).toHaveLength(1);
		expect(r.items[0].quantity).toBe(3);
	});

	it("set_quantity, remove_item, set_price", () => {
		expect(applyPatch(base, { op: "set_quantity", variant_id: "TOFFEE", quantity: 1 }).items[1].quantity).toBe(1);
		expect(applyPatch(base, { op: "remove_item", variant_id: "BLUE-M" }).items.map((i) => i.variant_id)).toEqual([
			"TOFFEE",
		]);
		expect(applyPatch(base, { op: "set_price", variant_id: "BLUE-M", price: usd("42.00") }).items[0].price).toEqual(
			usd("42.00"),
		);
	});

	it("add_custom_option accepts a back-order without duplicating the flag", () => {
		const opt = { name: "accept_back_order", value: "true" };
		const once = applyPatch(base, { op: "add_custom_option", variant_id: "TOFFEE", option: opt });
		const twice = applyPatch(once, { op: "add_custom_option", variant_id: "TOFFEE", option: opt });
		expect(twice.items[1].custom_options).toEqual([opt]);
	});

	it("remove_coupon and applyCoupon", () => {
		expect(applyPatch(base, { op: "remove_coupon", code: "welcome10-ab12" }).coupons).toEqual([]);
		expect(applyCoupon(base, "BUNDLE5-ZZ").coupons).toEqual([
			{ code: "WELCOME10-AB12", action: "APPLY" },
			{ code: "BUNDLE5-ZZ", action: "APPLY" },
		]);
	});

	it("set_checkout_field needs the buyer's value", () => {
		const patch = { op: "set_checkout_field" as const, type: "GIFT_MESSAGE" as const, value_schema: {} };
		expect(() => applyPatch(base, patch)).toThrow(/needs a value/);
		const r = applyPatch(base, patch, { type: "GIFT_MESSAGE", message: "Happy Diwali!" });
		expect(r.checkout_fields?.find((f) => f.type === "GIFT_MESSAGE")).toMatchObject({ status: "COMPLETED" });
	});
});
