/**
 * A counter the console bumps after each data refresh. Built-in widgets re-query on their
 * own; custom widgets get no data event in ag-studio 3.0.0, so they subscribe to this.
 */
import { useSyncExternalStore } from "react";

let version = 0;
const listeners = new Set<() => void>();

export function bumpDataVersion() {
	version += 1;
	for (const l of listeners) l();
}

export function useDataVersion(): number {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => version,
		() => version,
	);
}
