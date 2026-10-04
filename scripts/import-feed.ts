/**
 * Import a product feed (Google, PayPal Enhanced or OpenAI ACP; CSV/TSV/PSV) into a store.
 *
 *   pnpm import-feed <store-id> <feed-file>
 *
 * Upserts products and variants; rows that cannot be sold are skipped and listed.
 */
import { readFileSync } from "node:fs";
import { closeDb } from "@/src/db/client";
import { getMerchant } from "@/src/merchant/cart/repo";
import { importFeed } from "@/src/merchant/catalog/import";
import { publicUrl } from "@/src/public-url";

const [store, file] = process.argv.slice(2);
if (!store || !file) {
	console.error("usage: pnpm import-feed <store-id> <feed-file>");
	process.exit(2);
}

async function main() {
	if (!(await getMerchant(store)))
		throw new Error(`store '${store}' does not exist (run pnpm seed, or create the merchant first)`);
	const report = await importFeed(store, readFileSync(file, "utf8"), publicUrl());
	console.log(`${report.format}: ${report.products} products, ${report.variants} variants`);
	for (const s of report.skipped) console.log(`  skipped ${s.id ?? `row ${s.row}`}: ${s.reason}`);
}

main()
	.catch((e) => {
		console.error(e instanceof Error ? e.message : e);
		process.exitCode = 1;
	})
	.finally(closeDb);
