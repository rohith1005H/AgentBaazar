import { describe, expect, it } from "vitest";
import { listOrders, proposeAction, setAnalystData, summarize, widgetFor } from "./analyst";
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

	it("lists orders newest first, filtered by status", () => {
		setAnalystData({
			orders: [
				{ id: "AB-3", store: "Patel Textiles", status: "CAPTURED", total: 44.99, created_at: "2026-10-05T13:52:00Z" },
				{ id: "AB-2", store: "Lumen Ceramics", status: "AUTHORIZED", total: 31.48, created_at: "2026-10-05T12:00:00Z" },
			],
			carts: [],
			cart_stages: [],
			cart_issues: [],
		} as unknown as ConsoleData);
		expect(listOrders("captured")).toBe("AB-3 | Patel Textiles | CAPTURED | $44.99 | placed 2026-10-05T13:52:00Z");
		expect(listOrders("REFUNDED")).toBe("No REFUNDED orders.");
		expect(listOrders(undefined, 1).split("\n")).toHaveLength(1);
	});

	it("only prepares money actions: the merchant's button carries them out, once", () => {
		setAnalystData({
			orders: [
				{ id: "AB-1016", store_id: "patel-textiles", store: "Patel Textiles", status: "CAPTURED", total: 44.99 },
				{ id: "AB-1014", store_id: "patel-textiles", store: "Patel Textiles", status: "AUTHORIZED", total: 33.12 },
			],
			carts: [],
			cart_stages: [],
			cart_issues: [],
		} as unknown as ConsoleData);
		const refund = proposeAction("ab-1016", "refund", { amount: "5", reason: "late delivery" });
		expect(refund).toMatchObject({
			action: "refund",
			store_id: "patel-textiles",
			order_id: "AB-1016",
			question: "Refund $5.00 on AB-1016 through PayPal?",
			button: "Refund $5.00",
			body: { amount: { currency_code: "USD", value: "5.00" }, reason: "late delivery" },
		});
		// one request id per proposal, so a second click (or a reload) cannot refund twice
		expect(refund.body.request_id).toMatch(/^[0-9a-f-]{36}$/);
		expect(proposeAction("AB-1014", "ship").button).toBe("Ship and capture $33.12");
		expect(() => proposeAction("AB-1014", "refund")).toThrow(/AUTHORIZED/);
		expect(() => proposeAction("AB-1016", "ship")).toThrow(/CAPTURED/);
		expect(() => proposeAction("AB-1016", "refund", { amount: "five" })).toThrow(/not an amount/);
		expect(() => proposeAction("AB-9999", "cancel")).toThrow(/No order/);
	});
});
