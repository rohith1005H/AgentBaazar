"use client";
// AG Studio is about 1.6 MB gzipped: load it only on /console, and only in the browser.
import dynamic from "next/dynamic";

export default dynamic(() => import("./studio-console"), {
	ssr: false,
	loading: () => <p className="p-8 text-ink/60">Loading the console…</p>,
});
