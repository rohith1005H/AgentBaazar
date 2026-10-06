import { describe, expect, it } from "vitest";
import { offerTerms } from "./discovery";

describe("offer terms", () => {
	it("tell an agent the store's rules in plain words", () => {
		expect(
			offerTerms({
				firstOrderPct: 10,
				bundle: { minItems: 2, pct: 5 },
				maxTotalPct: 15,
				minSubtotalCents: 2500,
				freeShippingOverCents: 10000,
				expiresMinutes: 30,
			}),
		).toEqual([
			"10% off a first order",
			"5% off 2 or more items",
			"One offer per cart, the best that applies, from a $25.00 subtotal",
			"Free shipping on orders of $100.00 or more after discounts",
		]);
	});
});
