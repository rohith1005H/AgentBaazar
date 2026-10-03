/**
 * AgentBaazar extensions to the Cart API that live inside fields the spec
 * leaves open (`ResolutionOption.metadata`, `CartItem.custom_options`), so a
 * caller that ignores them still gets a fully spec-conformant cart.
 */
import type { CheckoutFieldType, Money } from "./schema";

/**
 * Machine-applicable patch attached to resolution options as `metadata.apply`.
 * A buyer agent can apply it to the cart it last received and PUT the result,
 * without interpreting prose. This is our extension inside the spec's free-form
 * `metadata` object; agents that ignore it lose nothing.
 */
export type CartPatch =
	| { op: "replace_variant"; variant_id: string; with_variant_id: string }
	| { op: "set_quantity"; variant_id: string; quantity: number }
	| { op: "remove_item"; variant_id: string }
	| { op: "add_custom_option"; variant_id: string; option: { name: string; value: string } }
	| { op: "set_price"; variant_id: string; price: Money }
	| { op: "remove_coupon"; code: string }
	| { op: "set_checkout_field"; type: CheckoutFieldType; value_schema: Record<string, string> };

/** Custom option names an agent sends to accept a delayed item (see CartPatch add_custom_option). */
export const ACCEPT_BACK_ORDER = "accept_back_order";
export const ACCEPT_PRE_ORDER = "accept_pre_order";
