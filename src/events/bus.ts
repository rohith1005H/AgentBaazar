/**
 * In-process event bus feeding the console's live view (SSE).
 * ponytail: single-instance only; switch to Postgres LISTEN/NOTIFY if we run more than one instance.
 */
import { EventEmitter } from "node:events";

export type StoreEvent =
	| { type: "cart"; store: string; cartId: string; status: string; totalCents: number; issues: string[] }
	| { type: "order"; store: string; orderId: string; status: string; totalCents: number }
	| { type: "webhook"; store: string; eventType: string; resourceId?: string };

const g = globalThis as unknown as { __abBus?: EventEmitter };
g.__abBus ??= new EventEmitter().setMaxListeners(100);
const bus = g.__abBus;

export const publish = (e: StoreEvent) => bus.emit("event", e);

export function subscribe(fn: (e: StoreEvent) => void): () => void {
	// publish() runs inside checkout and webhook handlers after their writes commit; a broken
	// listener (say a closed SSE stream) must not turn that into an error.
	const safe = (e: StoreEvent) => {
		try {
			fn(e);
		} catch {
			bus.off("event", safe);
		}
	};
	bus.on("event", safe);
	return () => bus.off("event", safe);
}
