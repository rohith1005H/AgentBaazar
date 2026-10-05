/**
 * The console's AI agent, built on AG Studio's agent framework with our own tools.
 *
 * Studio's built-in team (lead -> page -> widget agents) spends ~10 model calls and ~60 kB
 * of tool schema on one "add a chart" request, which a free LLM tier cannot serve. This
 * agent knows our data model up front and adds a fully configured widget in one tool call,
 * so a request is two model calls: decide, then confirm.
 */
import type { AgAiAgentDefinition, AgAiTool, AgReportState, AgStudioApi, AgWidgetState } from "ag-studio";
import type { ConsoleData } from "./console-data";
import { FIELDS } from "./data";
import type { ConsoleRegistry } from "./registry";

type Source = keyof typeof FIELDS;
const FIELD_IDS = (Object.keys(FIELDS) as Source[]).flatMap((src) => FIELDS[src].map((f) => `${src}.${f.id}`));
const WIDGET_TYPES = [
	"value",
	"donut-chart",
	"pie-chart",
	"bar-chart-grouped",
	"bar-chart-stacked",
	"column-chart-grouped",
	"column-chart-stacked",
	"line-chart",
	"grid",
	"cart-funnel",
] as const;
const AGGREGATIONS = ["sum", "count", "countd", "avg", "max", "min"] as const;

/** The data model in a few lines, so the agent never needs a schema lookup call. */
const SCHEMA = (Object.keys(FIELDS) as Source[])
	.map(
		(src) =>
			`${src}: ${FIELDS[src]
				.filter((f) => !f.hide)
				.map((f) => `${src}.${f.id} (${f.name ?? f.id}${f.description ? `: ${f.description}` : ""})`)
				.join("; ")}`,
	)
	.join("\n");

const INSTRUCTIONS = `You are the analyst in AgentBaazar's merchant console. The merchant sells through AI shopping agents that pay with PayPal: the payment is authorized at checkout and captured when the merchant ships.

Data (field ids are "<source>.<field>"):
${SCHEMA}

Use add_widget to build what the merchant asks for, in one call: pick the widget type, a short title, and fields from ONE source.
- value: one number (value + aggregation), e.g. orders.total sum
- donut-chart / pie-chart / bar / column / line: category + value (+ legend for bar/column)
- grid: columns
- cart-funnel: category = cart_stages.stage, value = cart_stages.cart_id with countd
Use summarize to answer questions about the numbers, then answer in one or two sentences with the figures.
Acting on orders (the merchant confirms each one in a dialog, so just call the tool):
- ship_order: an AUTHORIZED order; captures the PayPal payment and posts tracking
- cancel_order: an AUTHORIZED order that has not shipped; voids the authorization, nothing is charged
- refund_order: a CAPTURED or PARTIALLY_REFUNDED order; omit amount to refund the rest
If the merchant declines, say so and do not retry.
Money is in US dollars. Counting orders or carts: use countd on their id. Reply briefly; never invent numbers.`;

/** Rows the console fetched last, for summarize. */
let latest: ConsoleData | undefined;
export const setAnalystData = (d: ConsoleData) => {
	latest = d;
};

const sourceOf = (ref: string) => ref.split(".")[0] as Source;
const keyOf = (ref: string) => ref.split(".")[1];

export function widgetFor(args: AddWidgetArgs): AgWidgetState<ConsoleRegistry> {
	const value = args.value ? [{ id: args.value, aggregation: args.aggregation ?? "sum" }] : [];
	const format = { title: { enabled: true, text: args.title } };
	switch (args.type) {
		case "value":
			return { type: "value", dataMapping: { value }, format } as AgWidgetState<ConsoleRegistry>;
		case "grid":
			return {
				type: "grid",
				dataMapping: { cols: (args.columns ?? []).map((id) => ({ id })) },
				format,
			} as AgWidgetState<ConsoleRegistry>;
		case "cart-funnel":
			return {
				type: "cart-funnel",
				dataMapping: {
					stage: [{ id: args.category ?? "cart_stages.stage" }],
					value: [{ id: args.value ?? "cart_stages.cart_id", aggregation: args.aggregation ?? "countd" }],
				},
				format,
			} as AgWidgetState<ConsoleRegistry>;
		default:
			return {
				type: args.type,
				dataMapping: {
					categoryKey: args.category ? [{ id: args.category }] : [],
					valueKey: value,
					...(args.legend && { legendKey: [{ id: args.legend }] }),
				},
				format,
			} as AgWidgetState<ConsoleRegistry>;
	}
}

type AddWidgetArgs = {
	type: (typeof WIDGET_TYPES)[number];
	title: string;
	category?: string;
	value?: string;
	aggregation?: (typeof AGGREGATIONS)[number];
	legend?: string;
	columns?: string[];
};

/** Add a widget below everything on the page that is showing. */
function addWidget(api: AgStudioApi<ConsoleRegistry>, args: AddWidgetArgs): string {
	const refs = [args.category, args.value, args.legend, ...(args.columns ?? [])].filter(Boolean) as string[];
	const sources = new Set(refs.map(sourceOf));
	if (sources.size > 1) throw new Error(`Use fields from one source; got ${[...sources].join(", ")}`);
	if (args.type !== "grid" && !args.value && args.type !== "cart-funnel") throw new Error("value is required");
	if (args.type === "grid" && !args.columns?.length) throw new Error("columns are required for a grid");

	const state = api.getState() as AgReportState<ConsoleRegistry>;
	const pageId = state.selectedPageId ?? state.pages[0].id;
	const id = `ai-${Date.now().toString(36)}`;
	const pages = state.pages.map((p) => {
		if (p.id !== pageId) return p;
		const bottom = Math.max(0, ...Object.values(p.widgetLayout ?? {}).map((l) => (l ? l.yTrack + l.ySpan : 0)));
		const size =
			args.type === "value"
				? { xSpan: 6, ySpan: 7 }
				: args.type === "grid"
					? { xSpan: 24, ySpan: 18 }
					: { xSpan: 12, ySpan: 14 };
		return {
			...p,
			widgets: { ...p.widgets, [id]: widgetFor(args) },
			widgetLayout: { ...p.widgetLayout, [id]: { xTrack: 0, yTrack: bottom, ...size } },
		};
	});
	api.setState({ ...state, pages });
	return `Added "${args.title}" (${args.type}) at the bottom of the ${pageId} page.`;
}

export function summarize(args: {
	group_by: string;
	measure: string;
	aggregation: (typeof AGGREGATIONS)[number];
}): string {
	if (!latest) return "The data has not loaded yet.";
	const src = sourceOf(args.group_by);
	if (sourceOf(args.measure) !== src) return "group_by and measure must come from the same source.";
	const rows = latest[src] as Record<string, unknown>[];
	const groups = new Map<string, unknown[]>();
	for (const r of rows) {
		const g = String(r[keyOf(args.group_by)] ?? "(none)");
		groups.set(g, [...(groups.get(g) ?? []), r[keyOf(args.measure)]]);
	}
	const agg = (vs: unknown[]) => {
		const nums = vs.map(Number).filter((n) => !Number.isNaN(n));
		switch (args.aggregation) {
			case "count":
				return vs.length;
			case "countd":
				return new Set(vs.map(String)).size;
			case "avg":
				return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
			case "max":
				return Math.max(...nums);
			case "min":
				return Math.min(...nums);
			default:
				return nums.reduce((a, b) => a + b, 0);
		}
	};
	const out = [...groups].map(([g, vs]) => [g, agg(vs)] as const).sort((a, b) => b[1] - a[1]);
	return out
		.slice(0, 12)
		.map(([g, v]) => `${g}: ${Number.isInteger(v) ? v : v.toFixed(2)}`)
		.join("\n");
}

type OrderRow = { id: string; store_id: string; status: string; total: number };

function findOrder(orderId: string): OrderRow {
	const o = (latest?.orders as OrderRow[] | undefined)?.find((r) => r.id === orderId.trim().toUpperCase());
	if (!o) throw new Error(`No order ${orderId} in the console's data`);
	return o;
}

/**
 * Money moves only after the merchant confirms in the browser: the model can propose a
 * capture, void or refund, it cannot click OK.
 */
async function act(o: OrderRow, action: "ship" | "cancel" | "refund", question: string, body?: unknown) {
	if (!window.confirm(question)) throw new Error("The merchant declined; nothing was changed.");
	const res = await fetch(`/api/console/orders/${o.store_id}/${o.id}/${action}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	if (!res.ok) throw new Error(String(json.message ?? `${action} failed (${res.status})`));
	return json;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export function listOrders(status?: string, limit = 10): string {
	const rows = ((latest?.orders ?? []) as (OrderRow & { store: string; created_at: string })[])
		.filter((o) => !status || o.status === status.toUpperCase())
		.slice(0, Math.min(Math.max(1, limit), 25));
	if (!rows.length) return status ? `No ${status.toUpperCase()} orders.` : "No orders yet.";
	return rows.map((o) => `${o.id} | ${o.store} | ${o.status} | ${usd(o.total)} | placed ${o.created_at}`).join("\n");
}

export function analystAgent(api: AgStudioApi<ConsoleRegistry>, extra: AgAiTool[]): AgAiAgentDefinition {
	const tools = [
		api.defineAiTool<never, never, AddWidgetArgs, unknown>({
			name: "add_widget",
			description:
				"Add one fully configured widget (chart, number, table or the cart funnel) to the page that is showing.",
			params: (s) =>
				s.object({
					type: s.enum(WIDGET_TYPES),
					title: s.string({ description: "Short title shown on the widget" }),
					category: s.enum(FIELD_IDS, { description: "Field to group by (charts, cart-funnel)" }).optional(),
					value: s.enum(FIELD_IDS, { description: "Field to measure" }).optional(),
					aggregation: s.enum(AGGREGATIONS).optional(),
					legend: s.enum(FIELD_IDS, { description: "Optional field to split bars or columns by" }).optional(),
					columns: s.array(s.enum(FIELD_IDS), { description: "Columns, for a grid" }).optional(),
				}) as never,
			execute: (args, ctx) => {
				try {
					return ctx.success(addWidget(api, args));
				} catch (e) {
					return ctx.error((e as Error).message);
				}
			},
		}),
		api.defineAiTool<
			never,
			never,
			{ group_by: string; measure: string; aggregation: (typeof AGGREGATIONS)[number] },
			unknown
		>({
			name: "summarize",
			description:
				"Group one source's rows by a field and aggregate another field of the same source. Returns the top groups.",
			params: (s) =>
				s.object({
					group_by: s.enum(FIELD_IDS),
					measure: s.enum(FIELD_IDS),
					aggregation: s.enum(AGGREGATIONS),
				}) as never,
			execute: (args, ctx) => ctx.success(summarize(args)),
		}),
		api.defineAiTool<never, never, { status?: string; limit?: number }, unknown>({
			name: "list_orders",
			description: "List orders, newest first, optionally only those with one status (e.g. CAPTURED, AUTHORIZED).",
			params: (s) =>
				s.object({
					status: s.string({ description: "AUTHORIZED, CAPTURED, PARTIALLY_REFUNDED, REFUNDED, VOIDED..." }).optional(),
					limit: s.number({ description: "How many, default 10" }).optional(),
				}) as never,
			execute: ({ status, limit }, ctx) => ctx.success(listOrders(status, limit)),
		}),
		api.defineAiTool<never, never, { order_id: string }, unknown>({
			name: "ship_order",
			description: "Ship an AUTHORIZED order: captures the PayPal payment and posts the tracking number.",
			params: (s) => s.object({ order_id: s.string({ description: "Order number, e.g. AB-1006" }) }) as never,
			execute: async ({ order_id }, ctx) => {
				try {
					const o = findOrder(order_id);
					const r = await act(o, "ship", `Ship ${o.id}? This captures ${usd(o.total)} from the buyer's PayPal.`);
					return ctx.success(
						`Shipped ${o.id}: captured, PayPal capture ${r.capture_id}, tracking posted: ${r.tracking_posted}.`,
					);
				} catch (e) {
					return ctx.error((e as Error).message);
				}
			},
		}),
		api.defineAiTool<never, never, { order_id: string }, unknown>({
			name: "cancel_order",
			description:
				"Cancel an AUTHORIZED order that has not shipped: voids the PayPal authorization and returns the stock.",
			params: (s) => s.object({ order_id: s.string({ description: "Order number, e.g. AB-1006" }) }) as never,
			execute: async ({ order_id }, ctx) => {
				try {
					const o = findOrder(order_id);
					await act(
						o,
						"cancel",
						`Cancel ${o.id}? The ${usd(o.total)} authorization is voided; the buyer is not charged.`,
					);
					return ctx.success(`Cancelled ${o.id}: authorization voided.`);
				} catch (e) {
					return ctx.error((e as Error).message);
				}
			},
		}),
		api.defineAiTool<never, never, { order_id: string; amount?: string; reason?: string }, unknown>({
			name: "refund_order",
			description: "Refund a captured order through PayPal, in full or in part.",
			params: (s) =>
				s.object({
					order_id: s.string({ description: "Order number, e.g. AB-1006" }),
					amount: s.string({ description: 'US dollars, e.g. "5.00"; omit to refund the rest' }).optional(),
					reason: s.string({ description: "Short reason shown to the buyer" }).optional(),
				}) as never,
			execute: async ({ order_id, amount, reason }, ctx) => {
				try {
					const o = findOrder(order_id);
					if (amount && !/^\d+(\.\d{1,2})?$/.test(amount)) throw new Error(`"${amount}" is not an amount like 5.00`);
					const what = amount ? `$${Number(amount).toFixed(2)}` : "the rest of the payment";
					const r = await act(o, "refund", `Refund ${what} on ${o.id} through PayPal?`, {
						...(amount && { amount: { currency_code: "USD", value: Number(amount).toFixed(2) } }),
						...(reason && { reason: reason.slice(0, 200) }),
						request_id: crypto.randomUUID(), // one confirmed action, one refund
					});
					const refunded = (r.refunded as { value?: string } | undefined)?.value;
					return ctx.success(
						`Refunded $${refunded} on ${o.id} (PayPal refund ${r.refund_id}); order is now ${r.status}.`,
					);
				} catch (e) {
					return ctx.error((e as Error).message);
				}
			},
		}),
		...extra,
	];
	return {
		id: "analyst",
		name: "Merchant assistant",
		description: "Builds dashboard widgets, answers questions about agent sales, and ships, cancels or refunds orders.",
		schema: (s) => s.undefined(),
		instructions: () => INSTRUCTIONS,
		tools: () => tools,
		maxTurns: 6,
	};
}
