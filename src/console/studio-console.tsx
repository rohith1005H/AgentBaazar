"use client";

/**
 * The merchant console: AG Studio over live AgentBaazar data, with Studio's own AI agents
 * running on Gemini through our adapter (no key in the browser), a custom cart funnel
 * widget, and a Ship button that captures the PayPal authorization.
 */
import type {
	AgAiHarnessSetup,
	AgDataSourcesDefinition,
	AgGridWidgetOptions,
	AgStudioApi,
	AgStudioStateUpdatedEvent,
	AgWidgetField,
} from "ag-studio";
import { AgStudioAiModule, createAiHarness, directLlmRunner } from "ag-studio";
import { AgStudio, AgStudioProvider, createWidgets } from "ag-studio-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { analystAgent, setAnalystData } from "./analyst";
import { cartFunnelDef } from "./cart-funnel";
import type { ConsoleData } from "./console-data";
import { toSources } from "./data";
import { bumpDataVersion } from "./data-version";
import { studioLlmAdapter } from "./llm-adapter";
import type { ConsoleRegistry } from "./registry";
import { DEFAULT_REPORT, loadReport, REPORT_KEY } from "./report";
import { consoleTheme } from "./theme";

const MODULES = [AgStudioAiModule]; // stable reference; read once per Studio instance
const adapter = studioLlmAdapter();

async function fetchData(): Promise<AgDataSourcesDefinition<ConsoleRegistry>> {
	const res = await fetch("/api/console/data", { cache: "no-store" });
	if (res.status === 401) window.location.assign("/console/login");
	if (!res.ok) throw new Error(`console data HTTP ${res.status}`);
	const json = (await res.json()) as ConsoleData;
	setAnalystData(json);
	return toSources(json);
}

/** Grid cell for the `ship` field: value is "store/orderId" for authorized orders, null otherwise. */
function ShipCell({ value }: { value?: string | null }) {
	const [state, setState] = useState<"idle" | "busy" | "done" | "failed">("idle");
	if (!value) return null;
	if (state === "done") return <span>Shipped</span>;
	return (
		<button
			type="button"
			disabled={state === "busy"}
			title="Captures the PayPal authorization and posts tracking"
			onClick={async () => {
				setState("busy");
				const r = await fetch(`/api/console/orders/${value}/ship`, { method: "POST" }).catch(() => null);
				setState(r?.ok ? "done" : "failed");
			}}
			style={{
				font: "inherit",
				fontWeight: 600,
				fontSize: 12,
				lineHeight: "18px",
				padding: "0 10px",
				borderRadius: 5,
				border: "1px solid #3446a0",
				background: state === "failed" ? "#b4232c" : "#3446a0",
				color: "#fff",
				cursor: "pointer",
			}}
		>
			{state === "busy" ? "Shipping…" : state === "failed" ? "Retry" : "Ship"}
		</button>
	);
}

/**
 * Ship buttons in grid widgets. In ag-studio 3.0.0 the `overrides` type collapses to `never`
 * once the registry adds a custom widget (ExtractOverride is not distributive over the
 * registry's widget union), so the options are typed here and the override is cast.
 */
const gridOptions: AgGridWidgetOptions = {
	createCellRenderer: (field: AgWidgetField) =>
		(field.context as { cellRenderer?: string } | undefined)?.cellRenderer === "ship" ? ShipCell : undefined,
};

export default function StudioConsole() {
	const studio = useRef<AgStudio<ConsoleRegistry>>(null);
	const [data, setData] = useState<AgDataSourcesDefinition<ConsoleRegistry>>();
	const [initialState] = useState(loadReport); // read once; Studio ignores later changes
	const [dark, setDark] = useState(false);
	const [live, setLive] = useState(false);

	// Refresh on every store event (SSE) and every 30 s. Only row data is re-read.
	useEffect(() => {
		let alive = true;
		const refresh = () => fetchData().then((d) => alive && setData(d), console.error);
		refresh();
		const timer = setInterval(refresh, 30_000);
		const es = new EventSource("/api/console/events");
		es.onopen = () => setLive(true);
		es.onerror = () => setLive(false);
		es.onmessage = refresh; // ponytail: one fetch per event; debounce if events burst
		return () => {
			alive = false;
			clearInterval(timer);
			es.close();
		};
	}, []);

	// After Studio has taken the new rows (its own update runs first), tell custom widgets.
	useEffect(() => {
		if (!data) return;
		const t = setTimeout(bumpDataVersion, 0);
		return () => clearTimeout(t);
	}, [data]);

	useEffect(() => {
		document.documentElement.dataset.agThemeMode = dark ? "ab-dark" : "ab-light";
	}, [dark]);

	const widgets = useMemo(
		() =>
			createWidgets<ConsoleRegistry>({
				additionalTypes: [cartFunnelDef],
				overrides: [{ id: "grid", options: gridOptions }] as never,
			}),
		[],
	);

	const ai = useMemo<AgAiHarnessSetup>(
		() =>
			({ api }) =>
				createAiHarness(api, ({ tools }) => ({
					primary: "analyst",
					agents: [
						directLlmRunner({
							...analystAgent(api as AgStudioApi<ConsoleRegistry>, [tools.studio.removeWidget()]),
							adapter,
						}),
					],
					promptStarters: [
						{ label: "Sales by store", prompt: "Add a donut chart of agent sales by store." },
						{ label: "Orders to ship", prompt: "Add a table of authorized orders with store, total and placed date." },
						{ label: "Top problems", prompt: "Which problems did agents run into most often?" },
						{ label: "Refund $5", prompt: "Refund $5 on the most recent captured order for a late delivery." },
					],
				})),
		[],
	);

	const onStateUpdated = useCallback((e: AgStudioStateUpdatedEvent) => {
		localStorage.setItem(REPORT_KEY, JSON.stringify(e.state));
	}, []);

	const reset = useCallback(() => {
		localStorage.removeItem(REPORT_KEY);
		studio.current?.api.setState(DEFAULT_REPORT); // full state object, new reference
	}, []);

	return (
		<AgStudioProvider modules={MODULES} licenseKey={process.env.NEXT_PUBLIC_AG_STUDIO_LICENSE_KEY}>
			<div className="flex h-dvh flex-col bg-paper">
				<header className="flex items-center justify-between gap-4 bg-ink px-5 py-2.5 text-white">
					<div className="flex items-baseline gap-3">
						<a href="/" className="font-display text-[20px] leading-none">
							AgentBaazar
						</a>
						<span className="text-[13px] text-white/60">Merchant console</span>
						<span className="flex items-center gap-1.5 text-[12px] text-white/60" aria-live="polite">
							<span aria-hidden className={`h-2 w-2 rounded-full ${live ? "bg-emerald-400" : "bg-white/30"}`} />
							{live ? "Live" : "Connecting…"}
						</span>
					</div>
					<div className="flex items-center gap-2 text-[13px]">
						<a
							href="/shop"
							target="_blank"
							rel="noreferrer"
							className="rounded-md px-3 py-1 text-white/80 hover:bg-white/10"
						>
							Open the shopping agent
						</a>
						<button
							type="button"
							onClick={() => setDark((d) => !d)}
							className="rounded-md px-3 py-1 text-white/80 hover:bg-white/10"
						>
							{dark ? "Light" : "Dark"} mode
						</button>
						<button
							type="button"
							onClick={reset}
							className="rounded-md border border-white/25 px-3 py-1 hover:bg-white/10"
						>
							Reset report
						</button>
					</div>
				</header>
				<div className="min-h-0 flex-1">
					<AgStudio<ConsoleRegistry>
						ref={studio}
						style={{ height: "100%", width: "100%" }}
						data={data}
						initialState={initialState}
						widgets={widgets}
						theme={consoleTheme}
						ai={ai}
						mode="edit"
						onStateUpdated={onStateUpdated}
					/>
				</div>
			</div>
		</AgStudioProvider>
	);
}
