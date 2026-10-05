"use client";
import type { AgCartesianChartOptions } from "ag-charts-community";
import { BarSeriesModule, CategoryAxisModule, ModuleRegistry, NumberAxisModule } from "ag-charts-community";
import { AgCharts } from "ag-charts-react";
import type { AgBaseWidgetDefinition, AgWidgetParams } from "ag-studio";
import { getChartTheme } from "ag-studio";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDataVersion } from "./data-version";
import type { CartFunnelDef } from "./registry";

// Community (MIT) modules only: the Studio licence does not cover AG Charts Enterprise in custom widgets.
ModuleRegistry.registerModules([BarSeriesModule, CategoryAxisModule, NumberAxisModule]);

type Row = { stage: string; value: number; raw: unknown };

export function CartFunnel({ api, widgetApi, dataMapping }: AgWidgetParams<CartFunnelDef>) {
	const stage = dataMapping.stage?.at(0);
	const value = dataMapping.value?.at(0);
	const [rows, setRows] = useState<Row[] | null>(null);
	const loaded = useRef(false); // first load shows a prominent spinner, refreshes do not
	const dataVersion = useDataVersion();

	// biome-ignore lint/correctness/useExhaustiveDependencies: dataVersion re-runs the query when the console refreshes
	useEffect(() => {
		if (!stage || !value) {
			widgetApi.setDisplayState("incompleteDataMapping");
			return;
		}
		const ctrl = new AbortController();
		widgetApi.setDisplayState("loading", { prominent: !loaded.current });
		widgetApi
			.getData({ fields: [stage, value], sort: [{ field: value, direction: "desc" }] }, { signal: ctrl.signal })
			.then(({ results }) => {
				const next = results.rows.map((r) => ({
					stage: widgetApi.formatFieldValue(stage, r[stage.key]),
					value: Number(r[value.key] ?? 0),
					raw: r[stage.key],
				}));
				setRows(next);
				loaded.current = true;
				widgetApi.setDisplayState(next.length ? "displayed" : "noData");
			})
			.catch(() => {}); // aborted on re-render
		return () => ctrl.abort();
		// dataMapping changes and Studio re-renders the widget on filter/data changes
	}, [widgetApi, stage, value, dataVersion]);

	const options = useMemo<AgCartesianChartOptions | null>(() => {
		if (!rows || !stage || !value) return null;
		return {
			theme: getChartTheme(api), // Studio palette + fonts, follows the active theme mode
			background: { fill: "transparent" },
			data: rows,
			series: [
				{
					type: "bar",
					direction: "horizontal",
					xKey: "stage",
					yKey: "value",
					yName: widgetApi.getFieldName(value),
					listeners: {
						seriesNodeClick: ({ datum }) =>
							widgetApi.toggleCrossFilter({ type: "value", field: stage, value: (datum as Row).raw, group: 0 }),
					},
				},
			],
		};
	}, [rows, api, widgetApi, stage, value]);

	return (
		<div style={{ width: "100%", height: "100%" }}>
			{options && <AgCharts options={options} style={{ height: "100%" }} />}
		</div>
	);
}

export const cartFunnelDef: AgBaseWidgetDefinition<"cart-funnel", CartFunnelDef> = {
	id: "cart-funnel",
	label: "Agent cart funnel",
	dataMapping: {
		stage: {
			type: "field",
			supportedRoles: ["category"],
			requires: { cardinality: "many" },
			required: true,
			aiDescription: "Funnel stage",
		},
		value: {
			type: "field",
			supportedRoles: ["numeric"],
			requires: { per: "dataMapping.stage", cardinality: "one" },
			required: true,
			aiDescription: "Count or value per stage",
		},
	},
	form: (p) =>
		p.createDefaults({
			dataMappingItems: [
				{ key: "stage", label: "Stage" },
				{ key: "value", label: "Value" },
			],
		}),
	comp: CartFunnel,
	defaultSize: { width: 500, height: 320 },
	minSize: { width: 240, height: 160 },
	ai: { description: "Horizontal funnel of agent carts by stage; click a bar to cross-filter the page." },
};
