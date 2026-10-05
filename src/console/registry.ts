import type {
	AgBaseRegistry,
	AgBaseWidgetDefinition,
	AgDefaultWidgetDefinition,
	AgWidgetDataFormat,
	AgWidgetFieldReference,
} from "ag-studio";

/** State shape of our custom widget (what lives in the saved report JSON). */
export interface CartFunnelDef {
	type: "cart-funnel";
	dataMapping: { stage: AgWidgetFieldReference[]; value: AgWidgetFieldReference[] };
	format?: AgWidgetDataFormat<Record<string, never>>;
}

/** Pass as the generic everywhere (`AgStudio<ConsoleRegistry>`, `AgReportState<ConsoleRegistry>`, ...). */
export interface ConsoleRegistry extends AgBaseRegistry {
	widgets: readonly (AgDefaultWidgetDefinition | AgBaseWidgetDefinition<"cart-funnel", CartFunnelDef>)[];
}
