"use client";

/**
 * How each of the agent's tool calls appears in the chat: a one-line entry for routine
 * steps, and a card where the buyer has something to look at or decide.
 */
import { useEffect, useRef, useState } from "react";
import type { CartView, ProductView } from "@/src/platform/agent/tools";

type ToolPart = {
	type: string;
	toolCallId: string;
	state: string;
	input?: unknown;
	output?: unknown;
	errorText?: string;
	approval?: { id: string; isAutomatic?: boolean; requestReason?: string; reason?: string };
};

export type PartActions = {
	pick: (text: string) => void;
	approveFix: (approvalId: string, approved: boolean) => void;
	paypalDone: (toolCallId: string, approved: boolean) => void;
};

const failure = (o: unknown): string | undefined =>
	typeof o === "object" && o !== null && "error" in o ? String((o as { error: unknown }).error) : undefined;

function Entry({
	tone = "plain",
	children,
}: {
	tone?: "plain" | "issue" | "good" | "busy";
	children: React.ReactNode;
}) {
	const mark = { plain: "bg-rule", issue: "bg-madder", good: "bg-indigo", busy: "bg-rule animate-pulse" }[tone];
	return (
		<div className="flex items-start gap-3 py-1 text-[15px] leading-6 text-ink/80">
			<span aria-hidden className={`mt-[9px] h-1.5 w-1.5 shrink-0 rounded-full ${mark}`} />
			<div className="min-w-0">{children}</div>
		</div>
	);
}

function Issues({ cart }: { cart: CartView }) {
	if (cart.issues.length === 0) return null;
	return (
		<ul className="mt-1 space-y-1">
			{cart.issues.map((i) => (
				<li key={i.issue} className="border-l-2 border-madder pl-3 text-[14px] text-ink/75">
					{i.problem}
				</li>
			))}
		</ul>
	);
}

export function ToolEntry({ part, actions, busy }: { part: ToolPart; actions: PartActions; busy: boolean }) {
	const name = part.type.slice("tool-".length);
	const out = part.output;
	const err = part.state === "output-error" ? part.errorText : failure(out);
	if (err) return <Entry tone="issue">{err}</Entry>;
	// Anything short of a result (streaming input, waiting for an approval answer, executing)
	// is "in progress"; cards read `output` only once it exists.
	const running = part.state !== "output-available";

	switch (name) {
		case "set_budget": {
			const o = out as { max_total: string; deliver_by?: string } | undefined;
			return o ? (
				<Entry>
					Budget set to <Money>{o.max_total}</Money> for the whole order
					{o.deliver_by ? `, delivered by ${o.deliver_by}` : ""}.
				</Entry>
			) : null;
		}
		case "search_stores": {
			const q = (part.input as { query?: string } | undefined)?.query;
			if (running) return <Entry tone="busy">Searching the stores for “{q}”…</Entry>;
			const results = (out as { results: ProductView[] } | undefined)?.results ?? [];
			return (
				<div className="py-1">
					<Entry>
						{results.length ? `Found ${results.length} in the stores for “${q}”.` : `Nothing in the stores for “${q}”.`}
					</Entry>
					{results.length > 0 && <Products results={results} pick={actions.pick} disabled={busy} />}
				</div>
			);
		}
		case "create_cart": {
			if (running) return <Entry tone="busy">Opening a cart at the store…</Entry>;
			const c = out as CartView;
			return (
				<Entry tone={c.issues.length ? "issue" : "plain"}>
					Opened a cart at {storeName(c.store_id).replace(/\.$/, "")}.
					{c.issues.length
						? ` The store flagged ${c.issues.length === 1 ? "a problem" : `${c.issues.length} problems`}:`
						: ""}
					<Issues cart={c} />
				</Entry>
			);
		}
		case "apply_fix": {
			if (part.state === "approval-requested" && part.approval && !part.approval.isAutomatic)
				return (
					<FixApproval
						reason={part.approval.requestReason}
						onAnswer={(ok) => actions.approveFix(part.approval!.id, ok)}
					/>
				);
			if (part.state === "output-denied")
				return <Entry tone="issue">Not applied{part.approval?.reason ? `: ${part.approval.reason}` : "."}</Entry>;
			if (running) return <Entry tone="busy">Applying the store’s fix…</Entry>;
			const c = out as CartView & { applied?: string };
			return (
				<Entry tone="good">
					{c.applied ?? "Applied the store’s fix"}.
					<Issues cart={c} />
				</Entry>
			);
		}
		case "change_items":
			return running ? <Entry tone="busy">Updating the cart…</Entry> : <Entry>Updated the items in the cart.</Entry>;
		case "choose_shipping": {
			if (running) return <Entry tone="busy">Changing the shipping…</Entry>;
			const s = (out as CartView).shipping_options.find((o) => o.selected);
			return (
				<Entry>
					Shipping: {s ? `${s.name}, ${s.price}${s.delivery ? `, arrives by ${s.delivery}` : ""}` : "updated"}.
				</Entry>
			);
		}
		case "get_offer": {
			if (running) return <Entry tone="busy">Asking the store for a discount…</Entry>;
			const o = out as { offer: { code: string; description: string } | null; reason?: string };
			return o.offer ? (
				<Entry tone="good">
					The store offered <span className="font-mono text-[13px] text-ink">{o.offer.code}</span>:{" "}
					{o.offer.description}.
				</Entry>
			) : (
				<Entry>No discount on offer ({o.reason}).</Entry>
			);
		}
		case "request_paypal_approval": {
			if (part.state === "input-available")
				return (
					<PayPalApproval
						cartId={(part.input as { cart_id: string }).cart_id}
						onDone={(ok) => actions.paypalDone(part.toolCallId, ok)}
					/>
				);
			if (part.state === "output-available")
				return (out as { approved: boolean }).approved ? (
					<Entry tone="good">You approved the payment in PayPal.</Entry>
				) : (
					<Entry tone="issue">You did not approve the payment.</Entry>
				);
			return null;
		}
		case "complete_checkout": {
			if (part.state === "output-denied")
				return <Entry tone="issue">Payment blocked{part.approval?.reason ? `: ${part.approval.reason}` : "."}</Entry>;
			if (running) return <Entry tone="busy">Placing the order…</Entry>;
			const c = out as CartView;
			return c.order ? <OrderPlaced cart={c} /> : null;
		}
		case "order_status": {
			if (running) return <Entry tone="busy">Checking the order…</Entry>;
			const o = out as { order_id: string; status: string; shipments: { carrier: string; tracking_number: string }[] };
			const ship = o.shipments[0];
			return (
				<Entry>
					Order <span className="font-mono text-[13px]">{o.order_id}</span>: {o.status.toLowerCase().replace("_", " ")}
					{ship ? `, shipped with ${ship.carrier}, tracking ${ship.tracking_number}` : ", not shipped yet"}.
				</Entry>
			);
		}
		default:
			return null;
	}
}

const STORES: Record<string, string> = {
	"patel-textiles": "Patel Textiles",
	"kaveri-coffee": "Kaveri Coffee Co.",
	"lumen-ceramics": "Lumen Ceramics",
};
export const storeName = (id: string) => STORES[id] ?? id;

const Money = ({ children }: { children: React.ReactNode }) => (
	<span className="font-mono text-[14px] tabular-nums text-ink">{children}</span>
);

function Products({
	results,
	pick,
	disabled,
}: {
	results: ProductView[];
	pick: (t: string) => void;
	disabled: boolean;
}) {
	return (
		<ul className="mt-2 grid gap-3 sm:grid-cols-2">
			{results.map((p) => (
				<li key={`${p.store_id}/${p.product_id}`} className="flex gap-3 rounded-lg border border-rule bg-white p-3">
					{p.image_url && (
						// biome-ignore lint/performance/noImgElement: merchant feed images on arbitrary hosts
						<img src={p.image_url} alt="" className="h-16 w-16 shrink-0 rounded-md bg-paper object-cover" />
					)}
					<div className="min-w-0 flex-1">
						<p className="text-[11px] uppercase tracking-[0.12em] text-ink/50">{p.store_name}</p>
						<p className="font-medium leading-snug text-ink">{p.title}</p>
						<div className="mt-1.5 flex flex-wrap gap-1.5">
							{p.variants.slice(0, 6).map((v) => {
								const out = v.availability === "out_of_stock";
								return (
									<button
										key={v.variant_id}
										type="button"
										disabled={disabled || !p.agent_checkout}
										onClick={() => pick(`Buy the ${p.title} in ${v.label} from ${p.store_name}.`)}
										title={`${v.label}, ${v.price}, ${v.availability.replace("_", " ")}`}
										className={`rounded-full border px-2 py-0.5 text-[12px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo disabled:cursor-default ${
											out
												? "border-rule text-ink/35 line-through"
												: "border-indigo/30 text-ink hover:border-indigo hover:bg-indigo-soft"
										}`}
									>
										{v.label} · {v.price}
									</button>
								);
							})}
						</div>
						{!p.agent_checkout && <p className="mt-1 text-[12px] text-ink/50">Sold on the store’s own site only.</p>}
					</div>
				</li>
			))}
		</ul>
	);
}

function FixApproval({ reason, onAnswer }: { reason?: string; onAnswer: (ok: boolean) => void }) {
	return (
		<div className="my-2 rounded-lg border border-madder/40 bg-white p-4">
			<p className="text-[11px] uppercase tracking-[0.12em] text-madder">Your call</p>
			<p className="mt-1 text-[15px] leading-6 text-ink">{reason ?? "The store suggests a change to your cart."}</p>
			<div className="mt-3 flex gap-2">
				<button
					type="button"
					onClick={() => onAnswer(true)}
					className="rounded-md bg-ink px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
				>
					Accept
				</button>
				<button
					type="button"
					onClick={() => onAnswer(false)}
					className="rounded-md border border-rule px-3 py-1.5 text-sm font-medium text-ink hover:border-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo"
				>
					Decline
				</button>
			</div>
		</div>
	);
}

type ApprovalState = { approval_url: string | null; approved: boolean; within_budget: boolean | null; cart: CartView };

/** Opens PayPal's approval page and waits until the store sees the buyer's approval. */
function PayPalApproval({ cartId, onDone }: { cartId: string; onDone: (approved: boolean) => void }) {
	const [s, setS] = useState<ApprovalState | null>(null);
	const [opened, setOpened] = useState(false);
	const done = useRef(false);
	const finish = (ok: boolean) => {
		if (done.current) return;
		done.current = true;
		onDone(ok);
	};

	// biome-ignore lint/correctness/useExhaustiveDependencies: poll once per cart; finish is guarded by a ref
	useEffect(() => {
		let stop = false;
		let timer: ReturnType<typeof setTimeout>;
		const tick = async () => {
			const r = await fetch(`/api/agent/carts/${cartId}`).catch(() => null);
			if (r?.ok && !stop) {
				const next = (await r.json()) as ApprovalState;
				setS(next);
				if (next.approved) return finish(true);
			}
			if (!stop) timer = setTimeout(tick, 2500);
		};
		tick();
		return () => {
			stop = true;
			clearTimeout(timer);
		};
	}, [cartId]);

	const total = s?.cart.totals?.total;
	const over = s?.within_budget === false;
	return (
		<div className="my-2 rounded-lg border border-rule bg-white p-4">
			<p className="text-[11px] uppercase tracking-[0.12em] text-ink/50">Approve the payment</p>
			<p className="mt-1 text-[15px] leading-6 text-ink">
				{total ? (
					<>
						Pay <Money>{total}</Money> to {storeName(s!.cart.store_id)} with PayPal. You are charged only when the order
						ships.
					</>
				) : (
					"Getting the PayPal payment ready…"
				)}
			</p>
			{over && (
				<p className="mt-2 text-[14px] text-madder">
					This is over your budget. Decline, then ask the agent to change the cart.
				</p>
			)}
			<div className="mt-3 flex flex-wrap items-center gap-3">
				<button
					type="button"
					disabled={!s?.approval_url || over}
					onClick={() => {
						window.open(s!.approval_url!, "paypal-approval", "popup,width=480,height=720");
						setOpened(true);
					}}
					className="inline-flex h-10 items-center gap-1.5 rounded-full bg-pp-gold px-6 text-[15px] font-semibold text-pp-navy hover:brightness-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp-navy disabled:opacity-50"
				>
					Approve with <span className="italic tracking-tight">PayPal</span>
				</button>
				<button
					type="button"
					onClick={() => finish(false)}
					className="text-sm text-ink/60 underline-offset-2 hover:text-ink hover:underline"
				>
					Decline
				</button>
				{opened && !s?.approved && (
					<span className="text-[13px] text-ink/50" aria-live="polite">
						Waiting for your approval in PayPal…
					</span>
				)}
			</div>
			<p className="mt-3 text-[12px] text-ink/45">
				PayPal sandbox: use the sandbox buyer account. No real money moves.
			</p>
		</div>
	);
}

function OrderPlaced({ cart }: { cart: CartView }) {
	return (
		<div className="my-2 rounded-lg border border-indigo/30 bg-indigo-soft/50 p-4">
			<p className="text-[11px] uppercase tracking-[0.12em] text-indigo">Order placed</p>
			<p className="mt-1 text-[15px] leading-6 text-ink">
				Order <span className="font-mono text-[14px]">{cart.order!.order_id}</span> at {storeName(cart.store_id)}.
				PayPal authorized <Money>{cart.totals?.total}</Money>; you are charged when it ships.
			</p>
			{cart.order!.order_page && (
				<a
					href={cart.order!.order_page}
					target="_blank"
					rel="noreferrer"
					className="mt-2 inline-block text-sm font-medium text-indigo underline-offset-2 hover:underline"
				>
					View the order
				</a>
			)}
		</div>
	);
}
