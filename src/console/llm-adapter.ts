import type { AgAiEvent, AgLlmAdapter, AgLlmResponse } from "ag-studio";

/** One NDJSON line from /api/console/studio-llm. */
export type StudioLlmFrame = { event: AgAiEvent } | { done: AgLlmResponse };

/**
 * Browser-side AgLlmAdapter. Studio's own loop (directLlmRunner) calls executeTurn once per model
 * round; the server makes the Gemini call, so no key reaches the browser. Studio iterates `stream`
 * to the end, THEN awaits `complete`, and reads tool calls from `complete.output` (not the stream).
 */
export function studioLlmAdapter(endpoint = "/api/console/studio-llm"): AgLlmAdapter {
	return {
		executeTurn(request, options) {
			let resolve!: (r: AgLlmResponse) => void;
			let reject!: (e: Error) => void;
			const complete = new Promise<AgLlmResponse>((res, rej) => {
				resolve = res;
				reject = rej;
			});
			void complete.catch(() => {}); // observed even if Studio stops reading early

			async function* events(): AsyncGenerator<AgAiEvent> {
				try {
					const res = await fetch(endpoint, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(request),
						signal: options?.signal,
					});
					if (!res.ok || !res.body) throw new Error(`studio-llm HTTP ${res.status}`);
					const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
					let buf = "";
					let final: AgLlmResponse | undefined;
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						buf += value;
						for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
							const line = buf.slice(0, nl);
							buf = buf.slice(nl + 1);
							if (!line) continue;
							const frame = JSON.parse(line) as StudioLlmFrame;
							if ("event" in frame) yield frame.event;
							else final = frame.done;
						}
					}
					if (!final) throw new Error("studio-llm: stream ended without a response");
					resolve(final);
				} catch (e) {
					reject(e instanceof Error ? e : new Error(String(e)));
				}
			}
			const it = events();
			return { stream: { [Symbol.asyncIterator]: () => it }, complete };
		},
	};
}
