/**
 * The store's product page: where the feed's `link` points, and where an agent sends the
 * buyer when an item cannot be bought through the Cart API (REDIRECT_TO_MERCHANT).
 */
import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/src/db/client";
import { merchants, products, variants } from "@/src/db/schema";

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

const AVAILABILITY: Record<string, string> = {
	in_stock: "In stock",
	out_of_stock: "Out of stock",
	backorder: "Back-order",
	preorder: "Pre-order",
};

export default async function ProductPage(props: PageProps<"/m/[store]/p/[productId]">) {
	const { store, productId } = await props.params;
	const [row] = await db()
		.select({ p: products, storeName: merchants.name })
		.from(products)
		.innerJoin(merchants, eq(products.merchantId, merchants.id))
		.where(and(eq(products.id, productId), eq(products.merchantId, store)));
	if (!row) notFound();
	const { p, storeName } = row;
	const vs = await db().select().from(variants).where(eq(variants.productId, p.id)).orderBy(asc(variants.id));

	return (
		<main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-16">
			<p className="text-sm text-zinc-500">{storeName}</p>
			<div className="flex flex-col gap-6 sm:flex-row">
				{p.imageUrl && (
					// biome-ignore lint/performance/noImgElement: feed images are arbitrary merchant URLs
					<img src={p.imageUrl} alt={p.title} className="h-48 w-48 rounded-md bg-zinc-100 object-cover" />
				)}
				<div className="flex flex-col gap-2">
					<h1 className="text-2xl font-semibold">{p.title}</h1>
					{p.description && <p className="text-zinc-600 dark:text-zinc-400">{p.description}</p>}
				</div>
			</div>
			<table className="w-full text-sm">
				<tbody>
					{vs.map((v) => (
						<tr key={v.id} className="border-b border-zinc-200 dark:border-zinc-800">
							<td className="py-2">{[v.color, v.size].filter(Boolean).join(", ") || v.title}</td>
							<td className="py-2 text-zinc-500">
								{AVAILABILITY[v.availability] ?? v.availability}
								{v.restockEta && v.availability !== "in_stock" ? ` · ships ${v.restockEta}` : ""}
							</td>
							<td className="py-2 text-right tabular-nums">
								{v.salePriceCents ? (
									<>
										<s className="text-zinc-400">{usd(v.priceCents)}</s> {usd(v.salePriceCents)}
									</>
								) : (
									usd(v.priceCents)
								)}
							</td>
						</tr>
					))}
				</tbody>
			</table>
			{p.flags?.eligibleCheckout === false && (
				<p className="rounded-md bg-zinc-100 px-4 py-3 text-sm dark:bg-zinc-900">
					This item is sold directly by {storeName} and is not available to AI shopping agents.
				</p>
			)}
			<p className="text-xs text-zinc-400">AI shopping agents can buy from this store with PayPal via AgentBaazar.</p>
		</main>
	);
}
