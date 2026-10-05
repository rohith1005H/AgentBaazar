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
		...extra,
	];
	return {
		id: "analyst",
		name: "Merchant analyst",
		description: "Builds dashboard widgets and answers questions about agent sales, orders and carts.",
		schema: (s) => s.undefined(),
		instructions: () => INSTRUCTIONS,
		tools: () => tools,
		maxTurns: 6,
	};
}
