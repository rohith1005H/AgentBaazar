import { describe, expect, it } from "vitest";
import { ApiError, CART_ID_PATTERN, CartRequest, CheckoutRequest, PayPalCart, ValidationIssue } from "./schema";

// Samples are lifted from PayPal's Store Sync integration guide
// (developer.paypal.com/store-sync/integrate) so the schemas are checked against
// what PayPal itself documents, not against our own invention.

describe("PayPalCart response samples", () => {
	it("parses the create/update cart response", () => {
		const sample = {
			id: "CART-123",
			status: "CREATED",
			validation_status: "VALID",
			validation_issues: [],
			items: [
				{
					variant_id: "SHIRT-001",
					quantity: 1,
					name: "Blue T-Shirt",
					unit_amount: { currency_code: "USD", value: "25.00" },
					item_total: { currency_code: "USD", value: "25.00" },
				},
			],
			totals: {
				subtotal: { currency_code: "USD", value: "25.00" },
				shipping: { currency_code: "USD", value: "5.99" },
				tax: { currency_code: "USD", value: "2.70" },
				total: { currency_code: "USD", value: "33.69" },
			},
			payment_method: { type: "paypal", token: "EC-7U8939823K567" },
		};
		expect(PayPalCart.parse(sample).status).toBe("CREATED");
	});

	it("parses the completed-checkout response", () => {
		const sample = {
			id: "CART-123",
			status: "COMPLETED",
			validation_status: "VALID",
			validation_issues: [],
			payment_confirmation: {
				merchant_order_number: "ORDER-789",
				order_review_page: "https://yourstore.com/orders/789",
			},
			totals: { total: { currency_code: "USD", value: "37.19" } },
		};
		expect(PayPalCart.parse(sample).payment_confirmation?.merchant_order_number).toBe("ORDER-789");
	});

	it("parses a rich inventory validation issue with resolution options", () => {
		const issue = {
			code: "INVENTORY_ISSUE",
			type: "BUSINESS_RULE",
			message: "Product availability issue",
			user_message: "The Blue T-Shirt is currently out of stock. Would you like to try a different color?",
			variant_id: "SHIRT-BLUE-M",
			context: {
				specific_issue: "ITEM_OUT_OF_STOCK",
				available_quantity: 0,
				requested_quantity: 1,
				suggested_alternatives: ["SHIRT-RED-M", "SHIRT-GREEN-M"],
			},
			resolution_options: [
				{
					action: "SUGGEST_ALTERNATIVE",
					label: "View similar colors",
					metadata: { priority: "high", auto_applicable: true },
				},
			],
		};
		expect(ValidationIssue.parse(issue).resolution_options?.[0].action).toBe("SUGGEST_ALTERNATIVE");
	});
});

describe("request shapes", () => {
	it("accepts the documented update-cart request", () => {
		const req = {
			items: [{ variant_id: "EXISTING-ITEM-VARIANT", quantity: 5 }],
			customer: { email_address: "customer@example.com" },
			shipping_address: {
				address_line_1: "123 Current Street",
				admin_area_2: "Current City",
				admin_area_1: "CA",
				postal_code: "95131",
				country_code: "US",
			},
			payment_method: { type: "paypal" },
		};
		expect(CartRequest.parse(req).items).toHaveLength(1);
	});

	it("rejects an empty items array and a non-paypal payment type", () => {
		expect(CartRequest.safeParse({ items: [] }).success).toBe(false);
		expect(CheckoutRequest.safeParse({ payment_method: { type: "card", token: "x" } }).success).toBe(false);
	});

	it("accepts the documented checkout request", () => {
		expect(
			CheckoutRequest.parse({
				payment_method: { type: "paypal", token: "EC-7U8939823K567", payer_id: "PAYER123456789" },
			}).payment_method.payer_id,
		).toBe("PAYER123456789");
	});
});

describe("misc", () => {
	it("matches PayPal's documented cart id format", () => {
		expect(CART_ID_PATTERN.test("CART-01J9ABCDEF")).toBe(true);
		expect(CART_ID_PATTERN.test("invalid-cart-id-123")).toBe(false);
	});

	it("parses the documented 404 error envelope", () => {
		expect(
			ApiError.parse({
				name: "CART_NOT_FOUND",
				message: "Cart with ID 'CART-MISSING-123' does not exist",
				debug_id: "ERROR-404-12345",
				details: [{ field: "cartId", issue: "NOT_FOUND", description: "Verify the cart ID or create a new cart." }],
			}).name,
		).toBe("CART_NOT_FOUND");
	});
});
