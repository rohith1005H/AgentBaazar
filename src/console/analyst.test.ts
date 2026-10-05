import { describe, expect, it } from "vitest";
import { setAnalystData, summarize, widgetFor } from "./analyst";
import type { ConsoleData } from "./console-data";

describe("console analyst tools", () => {
	it("builds complete widget state in one step", () => {
		expect(
			widgetFor({ type: "donut-chart", title: "Sales by store", category: "orders.store", value: "orders.total" }),
		).toMatchObject({
			type: "donut-chart",
			dataMapping: { categoryKey: [{ id: "orders.store" }], valueKey: [{ id: "orders.total", aggregation: "sum" }] },
			format: { title: { text: "Sales by store" } },
		});
		expect(widgetFor({ type: "grid", title: "Orders", columns: ["orders.id", "orders.total"] }).dataMapping).toEqual({
			cols: [{ id: "orders.id" }, { id: "orders.total" }],
		});
		expect(widgetFor({ type: "cart-funnel", title: "Funnel" }).dataMapping).toEqual({
			stage: [{ id: "cart_stages.stage" }],
			value: [{ id: "cart_stages.cart_id", aggregation: "countd" }],
		});
	});

	it("summarizes the rows the console holds, biggest first", () => {
		setAnalystData({
			orders: [
				{ id: "AB-1", store: "Patel Textiles", total: 44.99 },
				{ id: "AB-2", store: "Kaveri Coffee Co.", total: 59.86 },
				{ id: "AB-3", store: "Patel Textiles", total: 39 },
			],
			carts: [],
			cart_stages: [],
			cart_issues: [
				{ cart_id: "C1", issue: "item out of stock" },
				{ cart_id: "C2", issue: "item out of stock" },
				{ cart_id: "C3", issue: "back ordered" },
			],
		} as unknown as ConsoleData);
		expect(summarize({ group_by: "orders.store", measure: "orders.total", aggregation: "sum" })).toBe(
			"Patel Textiles: 83.99\nKaveri Coffee Co.: 59.86",
		);
		expect(summarize({ group_by: "cart_issues.issue", measure: "cart_issues.cart_id", aggregation: "countd" })).toBe(
			"item out of stock: 2\nback ordered: 1",
		);
		expect(summarize({ group_by: "orders.store", measure: "carts.total", aggregation: "sum" })).toMatch(/same source/);
	});
});
