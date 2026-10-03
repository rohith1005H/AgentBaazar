/**
 * Order review page linked from the Cart API's payment_confirmation.order_review_page.
 * The link carries an HMAC (`k`), so order numbers cannot be enumerated; no buyer
 * contact details are shown.
 */
import { and, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { verifyLink } from "@/src/crypto";
import { db } from "@/src/db/client";
import { merchants, orderItems, orders, shipments } from "@/src/db/schema";

export const metadata = { title: "Order · AgentBaazar", robots: { index: false } };

const STATUS: Record<string, string> = {
	PENDING: "Payment in progress",
	PAYMENT_PENDING: "Payment pending with PayPal",
	AUTHORIZED: "Payment authorized. You will be charged when the order ships.",
	CAPTURE_PENDING: "Shipped. Payment is completing with PayPal.",
	CAPTURED: "Shipped and paid",
	VOIDED: "Cancelled. The authorization was released; you were not charged.",
	REFUNDED: "Refunded",
	PARTIALLY_REFUNDED: "Partially refunded",
	DISPUTED: "Under dispute",
};

const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

export default async function OrderPage(props: PageProps<"/m/[store]/orders/[orderId]">) {
	const { store, orderId } = await props.params;
	const { k } = await props.searchParams;
	if (!verifyLink(`${store}/${orderId}`, typeof k === "string" ? k : undefined)) notFound();

	const [row] = await db()
		.select({ o: orders, storeName: merchants.name })
		.from(orders)
		.innerJoin(merchants, eq(orders.merchantId, merchants.id))
		.where(and(eq(orders.id, orderId), eq(orders.merchantId, store)));
	if (!row) notFound();
	const { o, storeName } = row;
	const [items, ships] = await Promise.all([
		db().select().from(orderItems).where(eq(orderItems.orderId, o.id)),
		db().select().from(shipments).where(eq(shipments.orderId, o.id)),
	]);
	const totals = o.totals as Record<string, { value: string } | undefined>;

	return (
		<main className="mx-auto max-w-xl px-6 py-16 font-sans text-zinc-900">
			<p className="text-sm text-zinc-500">{storeName}</p>
			<h1 className="mt-1 text-2xl font-semibold">Order {o.id}</h1>
			<p className="mt-3 rounded-md bg-zinc-100 px-4 py-3 text-sm">{STATUS[o.status] ?? o.status}</p>

			<table className="mt-8 w-full text-sm">
				<tbody>
					{items.map((i) => (
						<tr key={i.id} className="border-b border-zinc-200">
							<td className="py-2">
								{i.qty} × {i.title}
							</td>
							<td className="py-2 text-right tabular-nums">{usd(i.unitCents * i.qty)}</td>
						</tr>
					))}
					{(["discount", "shipping", "shipping_discount", "tax"] as const).map((k) =>
						totals[k] && totals[k].value !== "0.00" ? (
							<tr key={k} className="text-zinc-500">
								<td className="pt-2 capitalize">{k.replace("_", " ")}</td>
								<td className="pt-2 text-right tabular-nums">
									{k.includes("discount") ? "-" : ""}${totals[k].value}
								</td>
							</tr>
						) : null,
					)}
					<tr className="font-semibold">
						<td className="pt-3">Total</td>
						<td className="pt-3 text-right tabular-nums">{usd(o.totalCents)}</td>
					</tr>
				</tbody>
			</table>

			{ships.length > 0 && (
				<section className="mt-8 text-sm">
					<h2 className="font-medium">Tracking</h2>
					{ships.map((s) => (
						<p key={s.id} className="mt-1 text-zinc-600">
							{s.carrier} {s.trackingNumber}
						</p>
					))}
				</section>
			)}
			<p className="mt-12 text-xs text-zinc-400">Paid with PayPal · Placed by an AI shopping agent via AgentBaazar</p>
		</main>
	);
}
