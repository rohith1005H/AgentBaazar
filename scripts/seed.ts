/**
 * Load the demo stores: merchant + policy, catalog feed, platform registry entry,
 * and the platform signing key.
 *
 *   pnpm seed            upsert stores and feeds (resets prices and stock to the feeds)
 *   pnpm seed --wipe     also delete the demo stores' carts, orders, coupons and events
 *
 * Safe to re-run. --wipe only touches rows belonging to the demo merchants.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, db } from "@/src/db/client";
import {
	cartEvents,
	carts,
	coupons,
	disputes,
	type MerchantPolicy,
	merchants,
	orderItems,
	orders,
	refunds,
	shipments,
	stores,
	webhookEvents,
} from "@/src/db/schema";
import { importFeed } from "@/src/merchant/catalog/import";
import { activeSigningKey } from "@/src/platform/stores/keys";
import { publicUrl } from "@/src/public-url";

type StoreFile = {
	id: string;
	name: string;
	feed: string;
	paymentMode: "authorize" | "capture";
	policy: MerchantPolicy;
};

const DIR = join(process.cwd(), "demo-data");
const base = publicUrl();

async function main() {
	const files = readdirSync(join(DIR, "stores")).filter((f) => f.endsWith(".json"));
	const defs = files.map((f) => JSON.parse(readFileSync(join(DIR, "stores", f), "utf8")) as StoreFile);
	const ids = defs.map((d) => d.id);

	if (process.argv.includes("--wipe")) await wipe(ids);

	for (const d of defs) {
		await db()
			.insert(merchants)
			.values({ id: d.id, name: d.name, paymentMode: d.paymentMode, policy: d.policy })
			.onConflictDoUpdate({
				target: merchants.id,
				set: { name: d.name, paymentMode: d.paymentMode, policy: d.policy },
			});
		const report = await importFeed(d.id, readFileSync(join(DIR, "feeds", d.feed), "utf8"), base);
		await db()
			.insert(stores)
			.values({ id: d.id, name: d.name, baseUrl: `${base}/api/stores/${d.id}/paypal/v1`, merchantId: d.id })
			.onConflictDoUpdate({
				target: stores.id,
				set: { name: d.name, baseUrl: `${base}/api/stores/${d.id}/paypal/v1`, merchantId: d.id, enabled: true },
			});
		console.log(
			`${d.id.padEnd(16)} ${report.format.padEnd(6)} ${report.products} products, ${report.variants} variants` +
				(report.skipped.length
					? `, skipped: ${report.skipped.map((s) => `${s.id ?? `row ${s.row}`} (${s.reason})`).join("; ")}`
					: ""),
		);
	}

	const key = await activeSigningKey();
	console.log(`signing key      ${key.kid}`);
}

async function wipe(ids: string[]) {
	await db().transaction(async (tx) => {
		const orderIds = tx.select({ id: orders.id }).from(orders).where(inArray(orders.merchantId, ids));
		const cartIds = tx.select({ id: carts.id }).from(carts).where(inArray(carts.merchantId, ids));
		await tx.delete(shipments).where(inArray(shipments.orderId, orderIds));
		await tx.delete(refunds).where(inArray(refunds.orderId, orderIds));
		await tx.delete(orderItems).where(inArray(orderItems.orderId, orderIds));
		await tx.delete(disputes).where(inArray(disputes.merchantId, ids));
		await tx.delete(orders).where(inArray(orders.merchantId, ids));
		await tx.delete(cartEvents).where(inArray(cartEvents.cartId, cartIds));
		await tx.delete(carts).where(inArray(carts.merchantId, ids));
		await tx.delete(coupons).where(inArray(coupons.merchantId, ids));
		await tx.delete(webhookEvents).where(inArray(webhookEvents.merchantId, ids));
	});
	const [{ n }] = await db().select({ n: sql<number>`count(*)::int` }).from(carts).where(eq(carts.merchantId, ids[0]));
	console.log(`wiped demo carts and orders (remaining carts for ${ids[0]}: ${n})`);
}

main()
	.catch((e) => {
		console.error(e);
		process.exitCode = 1;
	})
	.finally(closeDb);
