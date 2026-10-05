import type { AgStudioTheme, AgStudioThemeParams } from "ag-studio";
import { studioTheme } from "ag-studio";

// AgentBaazar: handloom indigo, ledger paper, madder red (used for problems), haldi and leaf as support.
const palette = {
	chartPaletteFills1Color: "#3446a0",
	chartPaletteFills2Color: "#d99a12",
	chartPaletteFills3Color: "#2f7d5b",
	chartPaletteFills4Color: "#b4232c",
	chartPaletteFills5Color: "#7b8bd1",
	chartPaletteFills6Color: "#1c2452",
} satisfies Partial<AgStudioThemeParams>;

/** One theme, two modes: `document.documentElement.dataset.agThemeMode = "ab-light" | "ab-dark"`. */
export const consoleTheme: AgStudioTheme = studioTheme
	.withParams({ ...palette, accentColor: "#3446a0", fontFamily: "var(--font-hind), system-ui, sans-serif" })
	.withParams(
		{
			backgroundColor: "#ffffff",
			foregroundColor: "#1c2452",
			borderColor: "#d9deee",
			studioCanvasBackgroundColor: "#f4f6fb",
			browserColorScheme: "light",
		},
		"ab-light",
	)
	.withParams(
		{
			backgroundColor: "#141a3d",
			foregroundColor: "#e7eaf6",
			borderColor: "#2b3570",
			studioCanvasBackgroundColor: "#0e1330",
			browserColorScheme: "dark",
		},
		"ab-dark",
	);
