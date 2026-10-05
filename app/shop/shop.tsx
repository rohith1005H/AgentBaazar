"use client";

import { useChat } from "@ai-sdk/react";
import {
	DefaultChatTransport,
	lastAssistantMessageIsCompleteWithApprovalResponses,
	lastAssistantMessageIsCompleteWithToolCalls,
} from "ai";
import { useEffect, useRef, useState } from "react";
import type { ShopperMessage } from "@/src/platform/agent/shopper";
import type { CartView } from "@/src/platform/agent/tools";
import { type PartActions, storeName, ToolEntry } from "./parts";

type SessionInfo = { buyer: string; ship_to: string; budget: string | null; deliver_by: string | null };

const EXAMPLES = [
	"A blue cotton kurta in size M, under $40. My budget is $60 in total.",
	"1 kg of Monsooned Malabar coffee beans. Budget $75.",
	"A small terracotta planter for my desk, under $50 all in.",
];

const CART_TOOLS = new Set(["create_cart", "apply_fix", "change_items", "choose_shipping", "complete_checkout"]);

/** The latest cart the agent has seen, and the budget it is working to. */
function ledgerState(messages: ShopperMessage[]) {
	let cart: CartView | undefined;
	let budget: string | undefined;
	for (const m of messages)
		for (const p of m.parts) {
			if (!p.type.startsWith("tool-") || !("state" in p) || p.state !== "output-available") continue;
			const name = p.type.slice(5);
			const out = p.output as Record<string, unknown>;
			if ("error" in out) continue;
			if (CART_TOOLS.has(name)) cart = out as unknown as CartView;
			if (name === "get_offer" && out.cart && !("error" in (out.cart as object))) cart = out.cart as CartView;
			if (name === "set_budget") budget = out.max_total as string;
		}
	return { cart, budget };
}

/** Assistant text: paragraphs and **bold**, nothing else (the model is asked to keep it short). */
function Prose({ text }: { text: string }) {
	return (
		<div className="space-y-2 text-[16px] leading-7 text-ink">
			{text
				.trim()
				.split(/\n{2,}/)
				.map((para, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of one message never reorder
					<p key={i} className="whitespace-pre-wrap">
						{para.split(/(\*\*[^*]+\*\*)/).map((bit, j) =>
							bit.startsWith("**") ? (
								// biome-ignore lint/suspicious/noArrayIndexKey: as above
								<strong key={j} className="font-semibold">
									{bit.slice(2, -2)}
								</strong>
							) : (
								bit
							),
						)}
					</p>
				))}
		</div>
	);
}

export default function Shop() {
	const [session, setSession] = useState<SessionInfo | null>(null);
	const [input, setInput] = useState("");
	const end = useRef<HTMLDivElement>(null);

	const { messages, sendMessage, addToolOutput, addToolApprovalResponse, status, error, regenerate, stop } =
		useChat<ShopperMessage>({
			transport: new DefaultChatTransport({ api: "/api/agent/chat" }),
			sendAutomaticallyWhen: (o) =>
				lastAssistantMessageIsCompleteWithToolCalls(o) || lastAssistantMessageIsCompleteWithApprovalResponses(o),
		});

	useEffect(() => {
		fetch("/api/agent/session")
			.then((r) => r.json())
			.then(setSession)
			.catch(() => setSession(null));
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll as the conversation grows
	useEffect(() => {
		end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
	}, [messages.length, status]);

	const busy = status === "submitted" || status === "streaming";
	const ready = Boolean(session) && !busy;
	const send = (text: string) => {
		if (!text.trim() || !ready) return;
		sendMessage({ text: text.trim() });
		setInput("");
	};
	const actions: PartActions = {
		pick: send,
		approveFix: (id, approved) => addToolApprovalResponse({ id, approved }),
		paypalDone: (toolCallId, approved) =>
			addToolOutput({ tool: "request_paypal_approval", toolCallId, output: { approved } }),
	};
	const { cart, budget } = ledgerState(messages);

	return (
		<div className="flex min-h-dvh flex-col bg-paper text-ink">
			<header className="bg-ink text-white">
				<div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3">
					<a href="/" className="flex items-baseline gap-2 focus-visible:outline-2 focus-visible:outline-white">
						<span className="font-display text-[22px] leading-none">AgentBaazar</span>
						<span className="font-display text-[15px] text-white/60" lang="hi">
							बाज़ार
						</span>
					</a>
					<span className="rounded-full border border-white/25 px-3 py-1 text-[12px] text-white/80">
						<span className="hidden sm:inline">PayPal sandbox · test money only</span>
						<span className="sm:hidden">Sandbox</span>
					</span>
				</div>
			</header>

			<main className="mx-auto grid w-full max-w-6xl flex-1 gap-6 px-5 py-6 lg:grid-cols-[minmax(0,1fr)_360px]">
				<section aria-label="Conversation with the shopping agent" className="flex min-h-[60vh] flex-col">
					<div className="flex-1 space-y-5">
						{messages.length === 0 && (
							<div className="pt-6 lg:pt-12">
								<h1 className="font-display text-[34px] leading-[1.1] text-ink sm:text-[42px]">
									Tell the agent what you need.
								</h1>
								<p className="mt-3 max-w-xl text-[17px] leading-7 text-ink/70">
									It shops small independent stores, sorts out problems with your cart, and pays with PayPal. You
									approve every payment, and you are charged only when the order ships.
								</p>
								<div className="mt-6 flex flex-col items-start gap-2">
									{EXAMPLES.map((e) => (
										<button
											key={e}
											type="button"
											disabled={!ready}
											onClick={() => send(e)}
											className="rounded-lg border border-rule bg-white px-4 py-2.5 text-left text-[15px] text-ink hover:border-indigo focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo disabled:opacity-50"
										>
											{e}
										</button>
									))}
								</div>
							</div>
						)}

						{messages.map((m, n) =>
							m.role === "user" ? (
								<div key={m.id} className="flex justify-end">
									<p className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo px-4 py-2.5 text-[16px] leading-6 text-white">
										{m.parts.map((p) => (p.type === "text" ? p.text : "")).join("")}
									</p>
								</div>
							) : (
								<div key={m.id} className="space-y-1">
									{m.parts.map((p, i) => {
										const key = `${m.id}-${i}`;
										if (p.type === "text") return p.text.trim() ? <Prose key={key} text={p.text} /> : null;
										if (p.type.startsWith("tool-"))
											return (
												<ToolEntry
													key={key}
													part={p as never}
													actions={actions}
													busy={busy}
													live={n === messages.length - 1}
												/>
											);
										return null;
									})}
								</div>
							),
						)}

						{status === "submitted" && <p className="text-[14px] text-ink/50">Thinking…</p>}
						{error && (
							<div className="rounded-lg border border-madder/40 bg-white p-3 text-[14px] text-ink">
								The agent could not answer. {error.message.length < 160 ? error.message : ""}{" "}
								<button type="button" onClick={() => regenerate()} className="font-medium text-indigo underline">
									Try again
								</button>
							</div>
						)}
						<div ref={end} />
					</div>

					<form
						className="sticky bottom-0 mt-6 flex gap-2 bg-paper pb-4 pt-2"
						onSubmit={(e) => {
							e.preventDefault();
							send(input);
						}}
					>
						<label htmlFor="ask" className="sr-only">
							Message the shopping agent
						</label>
						<input
							id="ask"
							value={input}
							onChange={(e) => setInput(e.currentTarget.value)}
							placeholder={session ? "What are you looking for?" : "Starting your session…"}
							autoComplete="off"
							maxLength={500}
							className="h-12 flex-1 rounded-lg border border-rule bg-white px-4 text-[16px] text-ink placeholder:text-ink/40 focus:border-indigo focus:outline-none"
						/>
						{busy ? (
							<button
								type="button"
								onClick={() => stop()}
								className="h-12 rounded-lg border border-rule bg-white px-4 text-[15px] font-medium text-ink"
							>
								Stop
							</button>
						) : (
							<button
								type="submit"
								disabled={!ready || !input.trim()}
								className="h-12 rounded-lg bg-ink px-5 text-[15px] font-medium text-white hover:bg-indigo focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo disabled:opacity-40"
							>
								Send
							</button>
						)}
					</form>
				</section>

				<Khata session={session} cart={cart} budget={budget ?? session?.budget ?? null} />
			</main>
		</div>
	);
}

/**
 * The khata: a merchant's ledger, kept for the buyer. Every line is something the store
 * actually charged, totalled against the budget the buyer gave the agent.
 */
function Khata({ session, cart, budget }: { session: SessionInfo | null; cart?: CartView; budget: string | null }) {
	const t = cart?.totals;
	const total = cart?.total_cents;
	const max = budget ? Math.round(Number(budget.replace("$", "")) * 100) : undefined;
	const spare = total !== undefined && max !== undefined ? max - total : undefined;
	const shipping = cart?.shipping_options.find((o) => o.selected);

	return (
		<aside aria-label="Your order ledger" className="lg:sticky lg:top-6 lg:self-start">
			<div className="relative overflow-hidden rounded-lg border border-rule shadow-[0_1px_0_#d9deee,0_12px_30px_-18px_rgba(28,36,82,0.35)]">
				<div className="bg-ink px-5 py-3 text-white">
					<p className="flex items-baseline justify-between">
						<span className="font-display text-[19px]">Khata</span>
						<span className="font-display text-[15px] text-white/60" lang="hi">
							खाता
						</span>
					</p>
					<p className="text-[12px] text-white/60">Your order, line by line</p>
				</div>
				<div className="ledger-paper relative px-5 pb-5 pt-2 pl-12 font-mono text-[13px] leading-[28px] text-ink">
					<span aria-hidden className="absolute inset-y-0 left-8 w-px bg-madder/60" />
					<Row label="For" value={session?.buyer ?? "…"} />
					<div className="flex justify-between gap-4">
						<span className="shrink-0 text-ink/75">Ship to</span>
						<span className="min-w-0 text-right">{session?.ship_to ?? "…"}</span>
					</div>
					<Row label="Budget" value={budget ?? "not set"} strong />

					{cart ? (
						<>
							<p className="mt-[28px] text-[11px] uppercase tracking-[0.14em] text-ink/50">
								{storeName(cart.store_id)}
							</p>
							{cart.items.map((i) => (
								<Row
									key={i.variant_id}
									label={`${i.quantity} × ${i.name ?? i.variant_id}`}
									value={i.unit_price ?? ""}
									wrap
								/>
							))}
							{t?.shipping && <Row label={`Shipping${shipping ? `, ${shipping.name}` : ""}`} value={t.shipping} wrap />}
							{t?.tax && <Row label="Tax" value={t.tax} />}
							{t?.discount && t.discount !== "$0.00" && (
								<Row label={`Discount${cart.coupons[0] ? ` ${cart.coupons[0]}` : ""}`} value={`−${t.discount}`} />
							)}
							{t && <Row label="Total" value={t.total} strong />}
							{spare !== undefined && (
								<p className={spare >= 0 ? "text-ink/60" : "text-madder"}>
									{spare >= 0
										? `Within budget, $${(spare / 100).toFixed(2)} to spare`
										: `Over budget by $${(-spare / 100).toFixed(2)}`}
								</p>
							)}
							{cart.issues.length > 0 && <p className="text-madder">{cart.issues.length} problem(s) to sort out</p>}
							{cart.order && (
								<div className="mt-4 flex justify-center">
									<div className="stamp rounded-md border-2 border-madder px-4 py-1.5 text-center leading-5 text-madder">
										<p className="text-[13px] font-medium tracking-[0.18em]">AUTHORIZED</p>
										<p className="text-[10px] tracking-[0.12em]">NOT CHARGED UNTIL SHIPPED</p>
										<p className="text-[11px] tracking-[0.12em]">{cart.order.order_id}</p>
									</div>
								</div>
							)}
						</>
					) : (
						<p className="mt-[28px] text-ink/45">No cart yet. Ask the agent for something.</p>
					)}
				</div>
			</div>
		</aside>
	);
}

function Row({ label, value, strong, wrap }: { label: string; value: string; strong?: boolean; wrap?: boolean }) {
	return (
		<div className={`flex justify-between gap-4 ${strong ? "font-medium" : ""}`}>
			<span className={wrap ? "min-w-0 text-ink/75" : "truncate text-ink/75"}>{label}</span>
			<span className="shrink-0 tabular-nums">{value}</span>
		</div>
	);
}
