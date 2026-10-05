import type { AgDataSourcesDefinition, AgFieldDefinition } from "ag-studio";
import type { ConsoleData } from "./console-data";
import type { ConsoleRegistry } from "./registry";

const usd = { format: "$#,##0.00" };
const low = "low" as const;

// Explicit fields: ISO strings are read as dates only when the field says so. Descriptions
// are read by Studio's AI, so they say what each number means.
const orderFields: AgFieldDefinition<ConsoleRegistry>[] = [
	{ id: "id", name: "Order", format: "textFormat" },
	{ id: "cart_id", format: "textFormat", hide: true },
	{ id: "store", name: "Store", format: "textFormat", cardinality: low },
	{
		id: "status",
		name: "Status",
		format: "textFormat",
		cardinality: low,
		description:
			"AUTHORIZED = paid by PayPal authorization, not yet captured; CAPTURED = shipped and charged; VOIDED, REFUNDED, PARTIALLY_REFUNDED, DISPUTED",
	},
	{ id: "total", name: "Total", format: "currencyFormat", formatOptions: usd },
	{ id: "coupon", name: "Coupon", format: "textFormat", cardinality: low },
	{
		id: "awaiting_ship",
		name: "Awaiting shipment",
		format: "integerFormat",
		description: "1 if the payment is authorized and the order has not shipped (sum = orders to ship)",
	},
	{
		id: "auth_age_hours",
		name: "Hours on hold",
		format: "decimalFormat",
		context: { cellRenderer: "hold-age" },
		description:
			"For authorized orders, hours since the buyer approved. PayPal guarantees the funds for 3 days (72 h): ship before then, oldest first",
	},
	{ id: "created_at", name: "Placed", format: "dateTimeFormat" },
	{ id: "captured_at", name: "Captured", format: "dateTimeFormat" },
	{
		id: "ship",
		name: "Ship",
		format: "textFormat",
		context: { cellRenderer: "ship" },
		description: "Ship button for authorized orders",
	},
];

const cartFields: AgFieldDefinition<ConsoleRegistry>[] = [
	{ id: "id", name: "Cart", format: "textFormat" },
	{ id: "store", name: "Store", format: "textFormat", cardinality: low },
	{ id: "status", name: "Status", format: "textFormat", cardinality: low },
	{ id: "total", name: "Cart total", format: "currencyFormat", formatOptions: usd },
	{ id: "created_at", name: "Opened", format: "dateTimeFormat" },
];

const stageFields: AgFieldDefinition<ConsoleRegistry>[] = [
	{ id: "cart_id", name: "Cart", format: "textFormat" },
	{ id: "store", name: "Store", format: "textFormat", cardinality: low },
	{
		id: "stage",
		name: "Stage",
		format: "textFormat",
		cardinality: low,
		description:
			"A stage the cart reached: Cart opened, Ready to pay, Approved in PayPal, Payment authorized, Captured on ship. Count distinct carts per stage for a funnel.",
	},
	{ id: "stage_rank", name: "Stage order", format: "integerFormat" },
];

const issueFields: AgFieldDefinition<ConsoleRegistry>[] = [
	{ id: "cart_id", name: "Cart", format: "textFormat" },
	{ id: "store", name: "Store", format: "textFormat", cardinality: low },
	{
		id: "issue",
		name: "Issue",
		format: "textFormat",
		cardinality: low,
		description: "A problem the store flagged on an agent's cart, e.g. item out of stock, back ordered, missing field",
	},
];

/** Every source's fields, for the console agent's tools (field refs are "<source>.<field>"). */
export const FIELDS: Record<"orders" | "carts" | "cart_stages" | "cart_issues", AgFieldDefinition<ConsoleRegistry>[]> =
	{
		orders: orderFields,
		carts: cartFields,
		cart_stages: stageFields,
		cart_issues: issueFields,
	};

/**
 * Sync sources: a refresh passes a new object with new row arrays. Only row data is re-read;
 * ids, fields and relationships must stay the same.
 */
export function toSources(json: ConsoleData): AgDataSourcesDefinition<ConsoleRegistry> {
	return {
		description:
			"AgentBaazar merchant data: carts that AI shopping agents opened at the stores through PayPal's Cart API, and the PayPal orders they became. Payment is authorized at checkout and captured when the merchant ships.",
		sources: [
			{ id: "orders", name: "Orders", description: "One row per PayPal order", data: json.orders, fields: orderFields },
			{ id: "carts", name: "Carts", description: "One row per agent cart", data: json.carts, fields: cartFields },
			{
				id: "cart_stages",
				name: "Cart stages",
				description: "One row per stage each cart reached",
				data: json.cart_stages,
				fields: stageFields,
			},
			{
				id: "cart_issues",
				name: "Cart issues",
				description: "One row per problem a store flagged on a cart",
				data: json.cart_issues,
				fields: issueFields,
			},
		],
		relationships: [
			{
				id: "orders-carts",
				source: { tableId: "orders", fieldId: "cart_id" },
				target: { tableId: "carts", fieldId: "id" },
				type: "many-to-one",
			},
			{
				id: "stages-carts",
				source: { tableId: "cart_stages", fieldId: "cart_id" },
				target: { tableId: "carts", fieldId: "id" },
				type: "many-to-one",
			},
			{
				id: "issues-carts",
				source: { tableId: "cart_issues", fieldId: "cart_id" },
				target: { tableId: "carts", fieldId: "id" },
				type: "many-to-one",
			},
		],
	};
}
