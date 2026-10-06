"use client";

/**
 * Ship, cancel and refund confirmations inside the AI chat. The agent's tool only prepares an
 * ActionProposal (analyst.ts); this panel, under the tool's step in the chat, shows it with a
 * button, and only the merchant's click calls the store.
 */
import type { AgAiToolDetailParams } from "ag-studio";
import type { AgAiToolDisplay } from "ag-studio-react";
import { useEffect, useState } from "react";
import type { ActionProposal } from "./analyst";

type Outcome = { state: "idle" | "busy" | "done" | "declined" | "failed"; text?: string };

// The chat can rebuild a step's panel (scrolling, history); a settled action keeps its outcome.
const outcomes = new Map<string, Outcome>();
const keyOf = (p: ActionProposal) => `${p.action}:${p.order_id}:${String(p.body.request_id ?? "")}`;

function summary(p: ActionProposal, r: Record<string, unknown>): string {
	if (p.action === "ship")
		return `Shipped ${p.order_id}: payment captured (PayPal ${r.capture_id}), tracking ${r.tracking_posted ? "posted" : "not posted"}.`;
	if (p.action === "cancel") return `Cancelled ${p.order_id}: authorization voided, nothing charged.`;
	const refunded = (r.refunded as { value?: string } | undefined)?.value;
	return `Refunded $${refunded} on ${p.order_id} (PayPal ${r.refund_id}). The order is now ${r.status}.`;
}

function ConfirmAction(params: AgAiToolDetailParams) {
	const p = params.status === "done" && params.result?.success ? (params.result.data as ActionProposal) : undefined;
	const [o, setO] = useState<Outcome>(() => (p && outcomes.get(keyOf(p))) ?? { state: "idle" });
	if (!p) return null; // a failed call shows Studio's own error
	const settle = (next: Outcome) => {
		outcomes.set(keyOf(p), next);
		setO(next);
	};
	const confirm = async () => {
		settle({ state: "busy" });
		const res = await fetch(`/api/console/orders/${p.store_id}/${p.order_id}/${p.action}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(p.body),
		}).catch(() => null);
		const json = ((await res?.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
		if (!res?.ok)
			settle({ state: "failed", text: String(json.message ?? "The store did not answer; nothing changed.") });
		else settle({ state: "done", text: summary(p, json) });
	};
	const busy = o.state === "busy";
	const button = {
		font: "inherit",
		fontWeight: 600,
		padding: "5px 12px",
		borderRadius: 6,
		cursor: busy ? "default" : "pointer",
	} as const;
	return (
		<div style={{ display: "grid", gap: 10, padding: "6px 0 4px" }}>
			<div>{p.question}</div>
			{o.state === "idle" || busy ? (
				<div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
					<button
						type="button"
						disabled={busy}
						onClick={confirm}
						style={{ ...button, border: "1px solid #3446a0", background: "#3446a0", color: "#fff" }}
					>
						{busy ? "Working…" : p.button}
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={() => settle({ state: "declined", text: "Cancelled. Nothing was changed." })}
						style={{ ...button, border: "1px solid currentColor", background: "transparent", color: "inherit" }}
					>
						Cancel
					</button>
				</div>
			) : (
				<div role="status" style={{ fontWeight: 600, color: o.state === "failed" ? "#b4232c" : undefined }}>
					{o.text}
				</div>
			)}
		</div>
	);
}

const display: AgAiToolDisplay = {
	label: ({ args, result }) => {
		const p = result?.success ? (result.data as ActionProposal) : undefined;
		return p
			? { text: p.question.replace(/\?.*$/, ""), pill: "Confirm" }
			: { text: `Preparing ${String(args.order_id ?? "the order")}` };
	},
	detail: ConfirmAction,
};

export const CONFIRM_DISPLAY: Record<string, AgAiToolDisplay> = {
	ship_order: display,
	cancel_order: display,
	refund_order: display,
};

/**
 * AG Studio 3.0 opens a tool step only when it is clicked; open each new "Confirm" step once,
 * so its buttons show in the chat straight away.
 * ponytail: keyed on Studio's step class names; recheck them when upgrading ag-studio.
 */
export function useOpenConfirmations() {
	useEffect(() => {
		const opened = new WeakSet<Element>();
		const open = () => {
			for (const row of document.querySelectorAll(".ag-studio-ai-step-row-interactive[aria-expanded='false']")) {
				if (opened.has(row) || row.querySelector(".ag-studio-ai-step-pill")?.textContent !== "Confirm") continue;
				opened.add(row);
				(row as HTMLElement).click();
			}
		};
		const watch = new MutationObserver(open);
		watch.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
		return () => watch.disconnect();
	}, []);
}
