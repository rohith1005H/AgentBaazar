/** Server-sent events: one message per cart, order or webhook event, so the console refreshes live. */
import { consoleAuthorized } from "@/src/console/auth";
import { subscribe } from "@/src/events/bus";

export async function GET(req: Request) {
	if (!(await consoleAuthorized())) return new Response("Sign in to the console", { status: 401 });
	const enc = new TextEncoder();
	let stop = () => {};
	const stream = new ReadableStream<Uint8Array>({
		start(ctrl) {
			const send = (s: string) => ctrl.enqueue(enc.encode(s));
			send(": connected\n\n");
			const unsubscribe = subscribe((e) => send(`data: ${JSON.stringify({ type: e.type, store: e.store })}\n\n`));
			const ping = setInterval(() => send(": ping\n\n"), 25_000); // keeps proxies from closing the stream
			stop = () => {
				clearInterval(ping);
				unsubscribe();
			};
			req.signal.addEventListener("abort", () => {
				stop();
				ctrl.close();
			});
		},
		cancel: () => stop(),
	});
	return new Response(stream, {
		headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" },
	});
}
