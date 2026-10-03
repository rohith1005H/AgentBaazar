import { describe, expect, it } from "vitest";
import { costImpact, percentOf, taxOf, toCents, toMoney } from "./money";

/** Exact half-up of cents * numerator / denominator using BigInt, as the reference. */
function exactHalfUp(cents: number, numerator: bigint, denominator: bigint): number {
	const n = BigInt(cents) * numerator;
	return Number((2n * n + denominator) / (2n * denominator));
}

describe("toCents / toMoney", () => {
	it("parses decimal strings exactly", () => {
		expect(toCents("0.10")).toBe(10);
		expect(toCents("12.3")).toBe(1230);
		expect(toCents("44.99")).toBe(4499);
		expect(() => toCents("1.234")).toThrow();
		expect(() => toCents("-1.00")).toThrow();
		expect(toMoney(4499)).toEqual({ currency_code: "USD", value: "44.99" });
		expect(costImpact(-3900)).toBe("-$39.00");
	});
});

describe("taxOf", () => {
	it("rounds half up at the boundaries floating point gets wrong", () => {
		// 3000 x 7.25% = 217.5 exactly; Math.round(3000 * 0.0725) gives 217
		expect(taxOf(3000, 0.0725)).toBe(218);
		expect(taxOf(200, 0.0725)).toBe(15);
		// 8.875% (NY) needs more than basis points: 1000 x 8.875% = 88.75 -> 89
		expect(taxOf(1000, 0.08875)).toBe(89);
		expect(taxOf(7800, 0.0825)).toBe(644);
		expect(taxOf(0, 0.1025)).toBe(0);
	});

	it("matches exact arithmetic for every amount up to $1,000 at every demo rate", () => {
		const rates: [number, bigint][] = [
			[0.0825, 82_500n],
			[0.0725, 72_500n],
			[0.08875, 88_750n],
			[0.1025, 102_500n],
			[0.07, 70_000n],
			[0.06, 60_000n],
		];
		for (const [rate, ppm] of rates) {
			for (let cents = 0; cents <= 100_000; cents++) {
				if (taxOf(cents, rate) !== exactHalfUp(cents, ppm, 1_000_000n))
					throw new Error(
						`taxOf(${cents}, ${rate}) = ${taxOf(cents, rate)}, exact ${exactHalfUp(cents, ppm, 1_000_000n)}`,
					);
			}
		}
	});
});

describe("percentOf", () => {
	it("rounds half up with integers only", () => {
		expect(percentOf(7800, 10)).toBe(780);
		expect(percentOf(5, 10)).toBe(1); // 0.5 -> 1
		expect(percentOf(4, 10)).toBe(0); // 0.4 -> 0
		expect(percentOf(7800, 15)).toBe(1170);
		for (let cents = 0; cents <= 20_000; cents++) {
			for (const pct of [5, 10, 12, 15, 20]) {
				if (percentOf(cents, pct) !== exactHalfUp(cents, BigInt(pct), 100n))
					throw new Error(`percentOf(${cents}, ${pct})`);
			}
		}
	});
});
