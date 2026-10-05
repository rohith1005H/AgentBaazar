import { describe, expect, it } from "vitest";
import type { PayPalCart } from "@/src/cart-spec/schema";
import { fixDecision, payDecision } from "./policy";

const usd = (value: string) => ({ currency_code: "USD", value });
const cart = (actions: [string, string?][], items = ["blue-m"]): PayPalCart => ({
	id: "CART-1",
	items: items.map((variant_id) => ({ variant_id, quantity: 1 })),
	totals: { total: usd("44.99") },
	validation_issues: [
		{
			code: "INVENTORY_ISSUE",
			type: "BUSINESS_RULE",
			message: "Blue M is out of stock",
			variant_id: "blue-m",
			resolution_options: actions.map(([action, cost_impact]) => ({
				action: action as never,
				label: action,
				metadata: { ...(cost_impact && { cost_impact }) },
			})),
		},
	],
});

describe("fixDecision", () => {
	it("applies a same-price or cheaper swap without asking", () => {
		expect(fixDecision(cart([["CHOOSE_DIFFERENT_VARIANT", "+$0.00"]]), 0, 0)).toBeUndefined();
		expect(fixDecision(cart([["CHOOSE_DIFFERENT_VARIANT", "-$3.00"]]), 0, 0)).toBeUndefined();
	});

	it("asks the buyer before anything that costs more or changes what they get", () => {
		expect(fixDecision(cart([["CHOOSE_DIFFERENT_VARIANT", "+$2.00"]]), 0, 0)?.type).toBe("user-approval");
		for (const a of ["ACCEPT_NEW_PRICE", "ACCEPT_BACK_ORDER", "ACCEPT_PRE_ORDER", "SPLIT_ORDER"])
			expect(fixDecision(cart([[a]]), 0, 0)?.type).toBe("user-approval");
	});

	it("asks before removing the last item, not before removing one of several", () => {
		expect(fixDecision(cart([["REMOVE_ITEM", "-$39.00"]]), 0, 0)?.type).toBe("user-approval");
		expect(fixDecision(cart([["REMOVE_ITEM", "-$39.00"]], ["blue-m", "beans"]), 0, 0)).toBeUndefined();
	});

	it("refuses fixes only the buyer can do, and ignores unknown references", () => {
		expect(fixDecision(cart([["REDIRECT_TO_MERCHANT"]]), 0, 0)?.type).toBe("denied");
		expect(fixDecision(cart([["CONTACT_SUPPORT"]]), 0, 0)?.type).toBe("denied");
		expect(fixDecision(cart([["REMOVE_ITEM"]]), 3, 0)).toBeUndefined();
	});
});

describe("payDecision", () => {
	const c = cart([]);
	it("never pays without a budget or above it", () => {
		expect(payDecision(c, null)?.type).toBe("denied");
		expect(payDecision(c, { max_total_cents: 4498 })?.type).toBe("denied");
		expect(payDecision(c, { max_total_cents: 4499 })).toBeUndefined();
		expect(payDecision(c, { max_total_cents: 6000 })).toBeUndefined();
	});
});
