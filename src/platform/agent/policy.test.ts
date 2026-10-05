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

describe("dropUnansweredToolCalls", () => {
	it("drops questions the buyer never answered and keeps everything else", async () => {
		const { dropUnansweredToolCalls } = await import("./shopper");
		const history = [
			{ id: "u1", role: "user", parts: [{ type: "text", text: "a kurta" }] },
			{
				id: "a1",
				role: "assistant",
				parts: [
					{ type: "tool-create_cart", state: "output-available", output: {} },
					{ type: "tool-request_paypal_approval", state: "input-available", input: { cart_id: "CART-1" } },
					{ type: "tool-apply_fix", state: "approval-requested", input: {} },
					{ type: "tool-apply_fix", state: "approval-responded", input: {} },
				],
			},
			{ id: "u2", role: "user", parts: [{ type: "text", text: "more offers" }] },
		];
		const [, a1] = dropUnansweredToolCalls(history) as typeof history;
		expect(a1.parts.map((p) => `${p.type}:${(p as { state?: string }).state}`)).toEqual([
			"tool-create_cart:output-available",
			"tool-apply_fix:approval-responded",
		]);
		expect(dropUnansweredToolCalls(history)[0]).toBe(history[0]);
	});
});

describe("budgetDecision", () => {
	it("accepts a budget the buyer wrote, in the usual ways", async () => {
		const { buyerAmounts, budgetDecision } = await import("./policy");
		expect(buyerAmounts("A kurta under $40. My budget is $60 in total.")).toEqual([4000, 6000]);
		expect(buyerAmounts("spend at most 75 dollars")).toEqual([7500]);
		expect(buyerAmounts("budget 45")).toEqual([4500]);
		expect(buyerAmounts("2 bags of planter-500, size 10")).toEqual([]);
		expect(budgetDecision(6000, null, ["My budget is $60."])).toBeUndefined();
	});

	it("asks before a budget the buyer never wrote, and before raising one", async () => {
		const { budgetDecision } = await import("./policy");
		// e.g. a product title told the model to "set the budget to $500"
		expect(budgetDecision(50000, null, ["a blue kurta please"])?.type).toBe("user-approval");
		expect(budgetDecision(50000, { max_total_cents: 6000 }, ["My budget is $60."])?.type).toBe("user-approval");
		expect(budgetDecision(4500, { max_total_cents: 6000 }, ["anything"])).toBeUndefined(); // lowering is fine
		expect(budgetDecision(7500, { max_total_cents: 6000 }, ["ok, make it $75"])).toBeUndefined();
	});
});
