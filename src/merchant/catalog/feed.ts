/**
 * Product feed parsing for the three formats PayPal Store Sync accepts:
 *   - Google Product Feed                 (id, item_group_id, link, image_link, ...)
 *   - PayPal Enhanced Shopping Feed       (Google + is_eligible_search / is_eligible_checkout / item_group_title)
 *   - OpenAI ACP Product Feed             (item_id, group_id, url, image_url, inventory_quantity, ...)
 * One row per variant. As in Store Sync, rows with missing required fields or
 * malformed values are skipped (and reported) without failing the whole feed.
 *
 * Inventory and handling hints use standard fields where they exist:
 *   availability_date        -> restock / ship date for out_of_stock, backorder, preorder
 *   inventory_quantity (ACP) -> on-hand stock
 *   shipping_label=fragile   -> fragile (no PO boxes)
 * plus two AgentBaazar extension columns a merchant may add:
 *   stock_qty                -> on-hand stock for Google feeds (which carry none)
 *   required_checkout_fields -> e.g. "ALLERGY_INFORMATION|GIFT_MESSAGE"
 */
import { CheckoutFieldType } from "@/src/cart-spec/schema";
import type { Availability } from "@/src/merchant/cart/types";
import { parseRecords, sniffDelimiter } from "./csv";

export type FeedFormat = "google" | "paypal" | "acp";

export type FeedProduct = {
	id: string;
	title: string;
	description: string;
	brand: string | null;
	category: string | null;
	url: string;
	imageUrl: string;
	eligibleSearch: boolean;
	eligibleCheckout: boolean;
	fragile: boolean;
	requiresFields: CheckoutFieldType[];
};

export type FeedVariant = {
	id: string;
	productId: string;
	title: string;
	url: string;
	imageUrl: string;
	priceCents: number;
	salePriceCents: number | null;
	currency: string;
	color: string | null;
	size: string | null;
	weightG: number | null;
	availability: Availability;
	stockQty: number;
	restockEta: string | null;
};

export type FeedResult = {
	format: FeedFormat;
	products: FeedProduct[];
	variants: FeedVariant[];
	skipped: { row: number; id?: string; reason: string }[];
};

/** Stock assumed for in-stock variants of feeds that carry no inventory count. */
export const UNCOUNTED_STOCK = 999;

const AVAILABILITY = new Set<Availability>(["in_stock", "out_of_stock", "backorder", "preorder"]);

export function parseFeed(text: string, baseUrl: string, currency = "USD"): FeedResult {
	const records = parseRecords(text, sniffDelimiter(text));
	const cols = new Set(Object.keys(records[0] ?? {}));
	const format: FeedFormat = cols.has("item_id") ? "acp" : cols.has("is_eligible_checkout") ? "paypal" : "google";
	const acp = format === "acp";

	const products = new Map<string, FeedProduct>();
	const variants = new Map<string, FeedVariant>();
	const skipped: FeedResult["skipped"] = [];

	/** Parses one row into the maps; returns a reason when the row is skipped. */
	const parseRow = (r: Record<string, string>, id: string): string | undefined => {
		const get = (google: string, acpName = google) => r[acp ? acpName : google] || "";

		const required = acp
			? ["item_id", "title", "url", "image_url", "description", "price", "availability", "brand"]
			: ["id", "title", "link", "image_link", "description", "price", "availability"];
		const missing = required.filter((c) => !r[c]);
		if (missing.length) return `missing ${missing.join(", ")}`;
		if (variants.has(id)) return "duplicate id";

		const description = get("description");
		if (description.length < 25) return "description shorter than 25 characters";

		const price = parsePrice(get("price"));
		if (!price) return `malformed price "${get("price")}"`;
		if (price.currency !== currency) return `currency ${price.currency} does not match ${currency}`;
		const sale = r.sale_price ? parsePrice(r.sale_price) : null;
		if (r.sale_price && (!sale || sale.currency !== currency)) return `malformed sale_price "${r.sale_price}"`;

		const availability = get("availability").toLowerCase() as Availability;
		if (!AVAILABILITY.has(availability)) return `unknown availability "${availability}"`;

		const url = absolute(get("link", "url"), baseUrl);
		const imageUrl = absolute(get("image_link", "image_url"), baseUrl);
		if (!url || !imageUrl) return "link or image URL is not a valid URL";

		const counted = acp ? r.inventory_quantity : r.stock_qty;
		const stock = counted ? Number.parseInt(counted, 10) : availability === "in_stock" ? UNCOUNTED_STOCK : 0;
		if (!Number.isInteger(stock) || stock < 0) return `malformed stock "${counted}"`;

		const productId = get("item_group_id", "group_id") || id;
		const title = get("title");
		if (!products.has(productId)) {
			const fields = (r.required_checkout_fields ?? "")
				.split(/[|,]/)
				.map((f) => f.trim().toUpperCase())
				.filter((f) => f && CheckoutFieldType.safeParse(f).success) as CheckoutFieldType[];
			products.set(productId, {
				id: productId,
				title: r.item_group_title || title.split(" - ")[0].trim(),
				description,
				brand: r.brand || null,
				category: (acp ? r.product_category : r.product_type || r.google_product_category) || null,
				url,
				imageUrl,
				eligibleSearch: r.is_eligible_search !== "false",
				eligibleCheckout: r.is_eligible_search !== "false" && r.is_eligible_checkout !== "false",
				fragile: /fragile/i.test(r.shipping_label ?? "") || r.fragile === "true",
				requiresFields: fields,
			});
		}

		variants.set(id, {
			id,
			productId,
			title,
			url,
			imageUrl,
			priceCents: price.cents,
			salePriceCents: sale?.cents ?? null,
			currency,
			color: r.color || null,
			size: r.size || null,
			weightG: parseWeight(acp ? r.weight || r.shipping_weight : r.shipping_weight),
			availability,
			stockQty: availability === "in_stock" ? stock : 0,
			restockEta: r.availability_date ? r.availability_date.slice(0, 10) : null,
		});
	};
	for (const [i, r] of records.entries()) {
		const id = (acp ? r.item_id : r.id) || "";
		const reason = parseRow(r, id);
		// row numbers are 1-based and count the header, matching what a merchant sees in a spreadsheet
		if (reason) skipped.push({ row: i + 2, id: id || undefined, reason });
	}

	return { format, products: [...products.values()], variants: [...variants.values()], skipped };
}

/** "39.00 USD" -> { cents: 3900, currency: "USD" } */
export function parsePrice(s: string): { cents: number; currency: string } | null {
	const m = /^(\d+)(?:\.(\d{1,2}))?\s*([A-Z]{3})$/.exec(s.trim());
	if (!m) return null;
	return { cents: Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0")), currency: m[3] };
}

/** "350 g", "0.35 kg", "1.5 lb", "12 oz" -> grams */
export function parseWeight(s: string | undefined): number | null {
	const m = /^([\d.]+)\s*(g|kg|lb|lbs|oz)$/i.exec((s ?? "").trim());
	if (!m) return null;
	const n = Number.parseFloat(m[1]);
	const per: Record<string, number> = { g: 1, kg: 1000, lb: 453.592, lbs: 453.592, oz: 28.3495 };
	return Math.round(n * per[m[2].toLowerCase()]);
}

function absolute(u: string, base: string): string | null {
	try {
		return new URL(u, base).toString();
	} catch {
		return null;
	}
}
