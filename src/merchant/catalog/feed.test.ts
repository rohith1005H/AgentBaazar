import { describe, expect, it } from "vitest";
import { parseDelimited, sniffDelimiter } from "./csv";
import { parseFeed, parsePrice, parseWeight, UNCOUNTED_STOCK } from "./feed";

const BASE = "https://shop.test";

describe("csv", () => {
	it("handles quotes, escaped quotes, embedded commas and newlines, CRLF and BOM", () => {
		const text = '﻿a,b,c\r\n1,"x, ""y""",3\r\n"multi\nline",,z\r\n';
		expect(parseDelimited(text)).toEqual([
			["a", "b", "c"],
			["1", 'x, "y"', "3"],
			["multi\nline", "", "z"],
		]);
	});

	it("sniffs TSV and PSV", () => {
		expect(sniffDelimiter("id\ttitle\tprice\n")).toBe("\t");
		expect(sniffDelimiter("id|title|price\n")).toBe("|");
		expect(sniffDelimiter("id,title,price\n")).toBe(",");
	});
});

describe("parsePrice / parseWeight", () => {
	it("parses feed money and weights", () => {
		expect(parsePrice("19.99 USD")).toEqual({ cents: 1999, currency: "USD" });
		expect(parsePrice("20 USD")).toEqual({ cents: 2000, currency: "USD" });
		expect(parsePrice("19,99 EUR")).toBeNull();
		expect(parseWeight("350 g")).toBe(350);
		expect(parseWeight("1.5 kg")).toBe(1500);
		expect(parseWeight("2 lb")).toBe(907);
		expect(parseWeight("")).toBeNull();
	});
});

// PayPal's own example rows from the Store Sync catalog guide, plus extensions.
const GOOGLE = `id,item_group_id,title,description,link,image_link,price,availability,color,size,availability_date,shipping_label,stock_qty
shirt123-red-m,shirt123,"Classic T-Shirt - Red, Medium","Comfortable cotton t-shirt in red, pre-washed",https://yourstore.com/products/shirt-red-m,https://yourstore.com/images/shirt-red-m.jpg,"19.99 USD","in_stock",red,medium,,,4
shirt123-red-l,shirt123,"Classic T-Shirt - Red, Large","Comfortable cotton t-shirt in red, pre-washed",/products/shirt-red-l,/images/shirt-red-l.jpg,"19.99 USD","backorder",red,large,2026-11-01,,
shirt123-blue-m,shirt123,"Classic T-Shirt - Blue, Medium","Comfortable cotton t-shirt in blue, pre-washed",https://yourstore.com/products/shirt-blue-m,https://yourstore.com/images/shirt-blue-m.jpg,"19.99 USD","in_stock",blue,medium,,,
vase-1,,"Tall Vase","A tall hand-thrown vase, glazed in cobalt blue",https://yourstore.com/products/vase,https://yourstore.com/images/vase.jpg,"65.00 USD","in_stock",,,,Fragile,2
bad-price,,"Broken","This row has a malformed price value here",https://yourstore.com/p,https://yourstore.com/i.jpg,"$5","in_stock",,,,,
short,,"Short","too short",https://yourstore.com/p,https://yourstore.com/i.jpg,"5.00 USD","in_stock",,,,,
eur,,"Euro","This row is priced in a different currency",https://yourstore.com/p,https://yourstore.com/i.jpg,"5.00 EUR","in_stock",,,,,
weird,,"Weird","This row has an availability we do not know",https://yourstore.com/p,https://yourstore.com/i.jpg,"5.00 USD","maybe",,,,,
,,"No id","This row is missing its identifier column",https://yourstore.com/p,https://yourstore.com/i.jpg,"5.00 USD","in_stock",,,,,
`;

describe("Google Product Feed", () => {
	const r = parseFeed(GOOGLE, BASE);

	it("detects the format and groups variants into products", () => {
		expect(r.format).toBe("google");
		expect(r.products.map((p) => p.id)).toEqual(["shirt123", "vase-1"]);
		expect(r.products[0].title).toBe("Classic T-Shirt");
		expect(r.variants.map((v) => v.id)).toEqual(["shirt123-red-m", "shirt123-red-l", "shirt123-blue-m", "vase-1"]);
	});

	it("maps price, stock, availability date, relative URLs and shipping_label", () => {
		const [redM, redL, blueM, vase] = r.variants;
		expect(redM).toMatchObject({ priceCents: 1999, stockQty: 4, color: "red", size: "medium" });
		expect(redL).toMatchObject({
			availability: "backorder",
			stockQty: 0,
			restockEta: "2026-11-01",
			url: "https://shop.test/products/shirt-red-l",
		});
		expect(blueM.stockQty).toBe(UNCOUNTED_STOCK);
		expect(vase.stockQty).toBe(2);
		expect(r.products[1].fragile).toBe(true);
		expect(r.products[0].eligibleCheckout).toBe(true);
	});

	it("skips malformed rows without failing the feed", () => {
		expect(r.skipped.map((s) => [s.row, s.reason])).toEqual([
			[6, 'malformed price "$5"'],
			[7, "description shorter than 25 characters"],
			[8, "currency EUR does not match USD"],
			[9, 'unknown availability "maybe"'],
			[10, "missing id"],
		]);
	});
});

describe("PayPal Enhanced and ACP feeds", () => {
	it("honours is_eligible_checkout and item_group_title", () => {
		const text = `id,item_group_id,item_group_title,title,description,link,image_link,price,availability,is_eligible_search,is_eligible_checkout
mug-1,mugs,Mug Set,"Mug Set - Blue","Hand-thrown stoneware mugs, set of four",/p/mug,/i/mug.jpg,48.00 USD,in_stock,true,false`;
		const r = parseFeed(text, BASE);
		expect(r.format).toBe("paypal");
		expect(r.products[0]).toMatchObject({ title: "Mug Set", eligibleSearch: true, eligibleCheckout: false });
	});

	it("reads ACP columns, inventory_quantity and required checkout fields", () => {
		const text = `item_id\tgroup_id\ttitle\turl\timage_url\tdescription\tprice\tsale_price\tavailability\tbrand\tinventory_quantity\tweight\tproduct_category\trequired_checkout_fields
toffee-250\ttoffee\tCardamom Toffee - 250g\t/p/toffee\t/i/toffee.jpg\tButtery coffee toffee with green cardamom, contains nuts\t12.00 USD\t10.00 USD\tin_stock\tKaveri\t40\t250 g\tFood > Confectionery\tALLERGY_INFORMATION|NOT_A_FIELD`;
		const r = parseFeed(text, BASE);
		expect(r.format).toBe("acp");
		expect(r.variants[0]).toMatchObject({ priceCents: 1200, salePriceCents: 1000, stockQty: 40, weightG: 250 });
		expect(r.products[0]).toMatchObject({ category: "Food > Confectionery", requiresFields: ["ALLERGY_INFORMATION"] });
	});
});
