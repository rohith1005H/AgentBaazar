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
