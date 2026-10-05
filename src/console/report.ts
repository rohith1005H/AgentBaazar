import type { AgReportState } from "ag-studio";
import type { ConsoleRegistry } from "./registry";

/** Bump when DEFAULT_REPORT changes so stale saved copies are discarded. */
export const REPORT_KEY = "ab.console.report.v4";

const title = (text: string) => ({ title: { enabled: true, text } });

// Field refs are "<sourceId>.<fieldId>". The layout grid is 24 columns; a row is 16 px.
export const DEFAULT_REPORT: AgReportState<ConsoleRegistry> = {
	selectedPageId: "Live",
	panels: { filters: { collapsed: true }, data: { collapsed: true }, ai: { collapsed: false } },
	pages: [
		{
			id: "Live",
			widgets: {
				gmv: {
					type: "value",
					dataMapping: { value: [{ id: "orders.total", aggregation: "sum" }] },
					format: title("Agent sales"),
				},
				toShip: {
					type: "value",
					dataMapping: { value: [{ id: "orders.awaiting_ship", aggregation: "sum" }] },
					format: title("To ship"),
				},
				orderCount: {
					type: "value",
					dataMapping: { value: [{ id: "orders.id", aggregation: "countd" }] },
					format: title("Orders"),
				},
				funnel: {
					type: "cart-funnel",
					dataMapping: {
						stage: [{ id: "cart_stages.stage" }],
						value: [{ id: "cart_stages.cart_id", aggregation: "countd" }],
					},
					format: title("Agent carts, stage by stage"),
				},
				byStore: {
					type: "bar-chart-stacked",
					dataMapping: {
						categoryKey: [{ id: "orders.store" }],
						valueKey: [{ id: "orders.total", aggregation: "sum" }],
						legendKey: [{ id: "orders.status" }],
					},
					format: { ...title("Sales by store and payment status"), crossFilter: "highlight" },
				},
				orders: {
					type: "grid",
					dataMapping: {
						cols: [
							{ id: "orders.id" },
							{ id: "orders.store" },
							{ id: "orders.status" },
							{ id: "orders.total", aggregation: "sum" },
							{ id: "orders.coupon" },
							{ id: "orders.created_at" },
							{ id: "orders.auth_age_hours", aggregation: "max" },
							{ id: "orders.ship" },
						],
					},
					sort: [{ field: { id: "orders.created_at" }, direction: "desc" }],
					format: title("Orders: ship to capture the PayPal payment"),
				},
			},
			widgetLayout: {
				gmv: { xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 7 },
				toShip: { xTrack: 4, yTrack: 0, xSpan: 4, ySpan: 7 },
				orderCount: { xTrack: 8, yTrack: 0, xSpan: 4, ySpan: 7 },
				funnel: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 19 },
				byStore: { xTrack: 0, yTrack: 7, xSpan: 12, ySpan: 12 },
				orders: { xTrack: 0, yTrack: 19, xSpan: 24, ySpan: 20 },
			},
		},
		{
			id: "Agent quality",
			widgets: {
				issues: {
					type: "bar-chart-stacked",
					dataMapping: {
						categoryKey: [{ id: "cart_issues.issue" }],
						valueKey: [{ id: "cart_issues.cart_id", aggregation: "countd" }],
						legendKey: [{ id: "cart_issues.store" }],
					},
					format: title("Problems agents ran into, by store"),
				},
				carts: {
					type: "grid",
					dataMapping: {
						cols: [
							{ id: "carts.id" },
							{ id: "carts.store" },
							{ id: "carts.status" },
							{ id: "carts.total", aggregation: "sum" },
							{ id: "carts.created_at" },
						],
					},
					sort: [{ field: { id: "carts.created_at" }, direction: "desc" }],
					format: title("Agent carts"),
				},
			},
			widgetLayout: {
				issues: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 16 },
				carts: { xTrack: 0, yTrack: 16, xSpan: 24, ySpan: 20 },
			},
		},
	],
};

export function loadReport(): AgReportState<ConsoleRegistry> {
	try {
		const saved = localStorage.getItem(REPORT_KEY);
		return saved ? (JSON.parse(saved) as AgReportState<ConsoleRegistry>) : DEFAULT_REPORT;
	} catch {
		return DEFAULT_REPORT;
	}
}
