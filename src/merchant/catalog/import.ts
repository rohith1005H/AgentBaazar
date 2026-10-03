/**
 * Upsert a parsed product feed into the merchant's catalog. Re-importing the
 * same feed is idempotent and resets prices, availability and stock to the
 * feed's values (which is also how the demo is reset).
 *
 * ponytail: variants missing from a later feed are left as-is; mark them
 * discontinued once merchants run incremental feeds.
 */
import { inArray, sql } from "drizzle-orm";
import { db } from "@/src/db/client";
import { products, variants } from "@/src/db/schema";
import { type FeedResult, parseFeed } from "./feed";

export type ImportReport = {
	format: FeedResult["format"];
	products: number;
	variants: number;
	skipped: FeedResult["skipped"];
};

export async function importFeed(merchantId: string, text: string, baseUrl: string): Promise<ImportReport> {
	const feed = parseFeed(text, baseUrl);
	const skipped = [...feed.skipped];

	// Ids are global keys: refuse rows that would overwrite another merchant's catalog.
	const productIds = feed.products.map((p) => p.id);
	const taken =
		productIds.length === 0
			? []
			: await db()
					.select({ id: products.id, merchantId: products.merchantId })
					.from(products)
					.where(inArray(products.id, productIds));
	const foreign = new Set(taken.filter((t) => t.merchantId !== merchantId).map((t) => t.id));
	for (const v of feed.variants.filter((v) => foreign.has(v.productId))) {
		skipped.push({ row: 0, id: v.id, reason: `product id ${v.productId} belongs to another store` });
	}
	const ownProducts = feed.products.filter((p) => !foreign.has(p.id));
	const ownVariants = feed.variants.filter((v) => !foreign.has(v.productId));

	await db().transaction(async (tx) => {
		if (ownProducts.length > 0) {
			await tx
				.insert(products)
				.values(
					ownProducts.map((p) => ({
						id: p.id,
						merchantId,
						groupId: p.id,
						title: p.title,
						description: p.description,
						brand: p.brand,
						category: p.category,
						url: p.url,
						imageUrl: p.imageUrl,
						flags: {
							fragile: p.fragile,
							requiresFields: p.requiresFields,
							eligibleSearch: p.eligibleSearch,
							eligibleCheckout: p.eligibleCheckout,
						},
					})),
				)
				.onConflictDoUpdate({
					target: products.id,
					set: {
						title: sql`excluded.title`,
						description: sql`excluded.description`,
						brand: sql`excluded.brand`,
						category: sql`excluded.category`,
						url: sql`excluded.url`,
						imageUrl: sql`excluded.image_url`,
						flags: sql`excluded.flags`,
					},
				});
		}
		if (ownVariants.length > 0) {
			await tx
				.insert(variants)
				.values(ownVariants.map((v) => ({ ...v, sku: v.id })))
				.onConflictDoUpdate({
					target: variants.id,
					set: {
						productId: sql`excluded.product_id`,
						title: sql`excluded.title`,
						url: sql`excluded.url`,
						imageUrl: sql`excluded.image_url`,
						priceCents: sql`excluded.price_cents`,
						salePriceCents: sql`excluded.sale_price_cents`,
						color: sql`excluded.color`,
						size: sql`excluded.size`,
						weightG: sql`excluded.weight_g`,
						availability: sql`excluded.availability`,
						stockQty: sql`excluded.stock_qty`,
						restockEta: sql`excluded.restock_eta`,
					},
				});
		}
	});

	return { format: feed.format, products: ownProducts.length, variants: ownVariants.length, skipped };
}
