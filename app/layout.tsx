import type { Metadata } from "next";
import { Hind, IBM_Plex_Mono, Tiro_Devanagari_Hindi } from "next/font/google";
import "./globals.css";

// Display: a Latin face drawn alongside Devanagari (the logo carries "बाज़ार").
const tiro = Tiro_Devanagari_Hindi({ weight: "400", subsets: ["latin", "devanagari"], variable: "--font-tiro" });
// Body: Hind, a UI face from the Indian Type Foundry. Figures: IBM Plex Mono.
const hind = Hind({ weight: ["400", "500", "600"], subsets: ["latin"], variable: "--font-hind" });
const plexMono = IBM_Plex_Mono({ weight: ["400", "500"], subsets: ["latin"], variable: "--font-plex-mono" });

export const metadata: Metadata = {
	title: "AgentBaazar",
	description: "Agent-ready commerce for every small store, on PayPal.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
	return (
		<html lang="en" className={`${tiro.variable} ${hind.variable} ${plexMono.variable} h-full antialiased`}>
			<body className="min-h-full flex flex-col font-sans">{children}</body>
		</html>
	);
}
