import { describe, expect, it } from "vitest";
import { relevant } from "./web-search";

const p = (title: string, slug: string) => ({ title, category: { slug } });

describe("relevant (web results)", () => {
	it("keeps the product asked for, in the category the matches agree on", () => {
		const kurtas = [
			p("Embroidered Udaipur Kurta", "clothing"),
			p("Amanda Anu Long Kurta", "clothing"),
			p("Long Kurta Shirt", "shirts-tops"),
			p("Haisley Floral Jumper", "clothing"),
		];
		expect(relevant("kurta", kurtas).map((x) => x.title)).toEqual([
			"Embroidered Udaipur Kurta",
			"Amanda Anu Long Kurta",
		]);
	});

	it("returns nothing rather than look-alikes when the catalog has no real match", () => {
		const junk = [
			p("Coffee Beans Glass Ornament", "holiday-ornaments"),
			p("Coffee Beans and You Journal", "notebooks"),
		];
		expect(relevant("coffee beans", junk)).toEqual([]);
	});

	it("accepts plurals", () => {
		const planters = [
			p("Terracotta Planters, set of 3", "pots-planters"),
			p("Tapered Terracotta Planter", "pots-planters"),
		];
		expect(relevant("terracotta planters", planters)).toHaveLength(2);
	});
});

describe("retryAfterMs (LLM cooldown)", () => {
	it("reads Gemini's retry hint, within bounds", async () => {
		const { retryAfterMs } = await import("@/src/llm");
		expect(retryAfterMs("Quota exceeded ... Please retry in 12.8025s.")).toBe(12_802.5);
		expect(retryAfterMs("Please retry in 10h41m45.8s")).toBe(38_505_800);
		expect(retryAfterMs("Please retry in 30h")).toBe(12 * 3_600_000);
		expect(retryAfterMs("Please retry in 1.2s")).toBe(5_000);
		expect(retryAfterMs("model overloaded")).toBe(60_000);
	});
});
