/**
 * The buyer agent's spending rules, as plain functions of the store's cart: the model
 * proposes, these decide. Used as AI SDK tool approvals in shopper.ts.
 */
import type { PayPalCart } from "@/src/cart-spec/schema";
import { toCents } from "@/src/merchant/cart/money";
import type { Mandate } from "./session";

export type Decision = undefined | { type: "denied" | "user-approval"; reason: string };

const ASK_FIRST = new Set(["ACCEPT_NEW_PRICE", "ACCEPT_BACK_ORDER", "ACCEPT_PRE_ORDER", "SPLIT_ORDER"]);
const HANDS_OFF = new Set(["CONTACT_SUPPORT", "REDIRECT_TO_MERCHANT"]);

/** Apply a store's fix right away, ask the buyer first, or refuse it. */
export function fixDecision(cart: PayPalCart | undefined, issue: number, option: number): Decision {
	const iss = cart?.validation_issues?.[issue];
	const opt = iss?.resolution_options?.[option];
	if (!opt) return undefined; // the tool itself reports the bad reference
	if (HANDS_OFF.has(opt.action))
		return { type: "denied", reason: `"${opt.label}" has to be done by the buyer on the store's site` };
	const cost = typeof opt.metadata?.cost_impact === "string" ? opt.metadata.cost_impact : "";
	// "+$2.00" costs more; "+$0.00" and "-$39.00" do not
	const costsMore = /^\+\$/.test(cost) && toCents(cost.slice(2)) > 0;
	const emptiesCart =
		opt.action === "REMOVE_ITEM" && (cart?.items ?? []).every((i) => i.variant_id === iss?.variant_id);
	if (ASK_FIRST.has(opt.action) || costsMore || emptiesCart)
		return {
			type: "user-approval",
			reason: `${iss?.user_message ?? iss?.message} Proposed: ${opt.label}${cost ? ` (${cost})` : ""}.`,
		};
	return undefined;
}

/** Pay only with a budget, and never above it. */
export function payDecision(cart: PayPalCart | undefined, mandate: Mandate | null): Decision {
	if (!mandate) return { type: "denied", reason: "Ask the buyer for a budget before paying." };
	const total = cart?.totals?.total.value;
	if (total && toCents(total) > mandate.max_total_cents)
		return {
			type: "denied",
			reason: `The total $${total} is over the buyer's budget of $${(mandate.max_total_cents / 100).toFixed(2)}.`,
		};
	return undefined;
}
