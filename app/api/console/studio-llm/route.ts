import type { AgAiOutputItem, AgLlmRequest, AgLlmResponse } from "ag-studio";
import { jsonSchema, streamText, type ToolSet } from "ai";
import { consoleAuthorized } from "@/src/console/auth";
import type { StudioLlmFrame } from "@/src/console/llm-adapter";
import { clean, type Json, type SignedCall, toModelMessages, toToolChoice } from "@/src/console/studio-bridge";
import { llm } from "@/src/llm";
import { log } from "@/src/log";

export const runtime = "nodejs";

const MAX_BODY = 300_000;

export async function POST(req: Request): Promise<Response> {
	if (!(await consoleAuthorized())) return new Response("Sign in to the console", { status: 401 });
	const raw = await req.text();
	if (raw.length > MAX_BODY) return new Response("Request too large", { status: 413 });
	let body: AgLlmRequest;
	try {
		body = JSON.parse(raw) as AgLlmRequest;
	} catch {
		return new Response("Body is not JSON", { status: 400 });
	}
	log.info({ bytes: raw.length, tools: body.tools?.length ?? 0 }, "studio turn"); // sizes only, for quota tuning

	const tools: ToolSet = {};
	for (const t of body.tools ?? []) {
		if (t.kind === "provided" || t.kind === "server") continue; // Studio never asks us to run these
		tools[t.name] = { description: t.description, inputSchema: jsonSchema(clean(t.parameters as Json)) }; // no execute: model proposes, Studio executes
	}
	const { messages, system } = toModelMessages(body.input);

	const result = streamText({
		model: llm("console"),
		instructions: [body.instructions, ...system].filter(Boolean).join("\n\n"),
		messages,
		tools,
		toolChoice: toToolChoice(body.toolChoice),
		abortSignal: req.signal,
		maxRetries: 0, // the model pool in src/llm.ts retries across models
	});

	const enc = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(ctrl) {
			const send = (f: StudioLlmFrame) => ctrl.enqueue(enc.encode(`${JSON.stringify(f)}\n`));
			const output: AgAiOutputItem[] = [];
			const text = new Map<string, string>();
			const startedCalls = new Set<string>();
			const done = (r: Omit<AgLlmResponse, "id" | "createdAt" | "output">) =>
				send({ done: { id: crypto.randomUUID(), createdAt: Date.now(), output, ...r } });
			try {
				for await (const p of result.fullStream) {
					switch (p.type) {
						case "text-start":
							text.set(p.id, "");
							send({ event: { type: "TEXT_MESSAGE_START", messageId: p.id, role: "assistant" } });
							break;
						case "text-delta":
							text.set(p.id, (text.get(p.id) ?? "") + p.text);
							send({ event: { type: "TEXT_MESSAGE_CONTENT", messageId: p.id, delta: p.text } });
							break;
						case "text-end":
							send({ event: { type: "TEXT_MESSAGE_END", messageId: p.id } });
							output.push({
								id: p.id,
								kind: "output",
								type: "message",
								role: "assistant",
								status: "completed",
								content: [{ type: "text", text: text.get(p.id) ?? "", annotations: [] }],
							});
							break;
						// Reasoning (Gemma 4 streams it) is not forwarded: Studio's chat stalls on bare
						// REASONING_MESSAGE_CHUNK events, and the merchant does not need to read it.
						case "tool-input-start":
							startedCalls.add(p.id);
							send({ event: { type: "TOOL_CALL_START", toolCallId: p.id, toolCallName: p.toolName } });
							break;
						case "tool-input-delta":
							send({ event: { type: "TOOL_CALL_ARGS", toolCallId: p.id, delta: p.delta } });
							break;
						case "tool-input-end":
							send({ event: { type: "TOOL_CALL_END", toolCallId: p.id } });
							break;
						case "tool-call": {
							const args = JSON.stringify(p.input ?? {});
							if (!startedCalls.has(p.toolCallId)) {
								// Provider gave the call in one piece: synthesise the streamed form for the panel.
								send({
									event: { type: "TOOL_CALL_CHUNK", toolCallId: p.toolCallId, toolCallName: p.toolName, delta: args },
								});
							}
							const sig = (p.providerMetadata?.google as Json | undefined)?.thoughtSignature;
							const call: SignedCall = {
								id: p.toolCallId,
								kind: "output",
								type: "function_call",
								callId: p.toolCallId,
								name: p.toolName,
								arguments: args,
								status: "completed",
								...(typeof sig === "string" ? { thoughtSignature: sig } : {}),
							};
							output.push(call);
							break;
						}
						case "error":
							throw p.error;
						case "finish":
							done({
								status: p.finishReason === "length" ? "incomplete" : "completed",
								incompleteDetails: p.finishReason === "length" ? { reason: "max_output_tokens" } : undefined,
								usage: {
									inputTokens: p.totalUsage.inputTokens ?? 0,
									outputTokens: p.totalUsage.outputTokens ?? 0,
									totalTokens: p.totalUsage.totalTokens ?? 0,
								},
							});
							break;
					}
				}
			} catch (e) {
				// 429 from the free tier lands here; Studio shows it as a failed run.
				// Never show raw provider errors (they carry account ids); say what the merchant can do.
				const busy = /quota|rate limit|429|exhausted|high demand|overloaded/i.test(String((e as Error)?.message ?? e));
				log.warn({ err: String((e as Error)?.message ?? e).slice(0, 160) }, "studio turn failed");
				done({
					status: "failed",
					error: {
						code: busy ? "rate_limited" : "llm_error",
						message: busy
							? "The free AI quota is busy right now. Wait a minute and ask again."
							: "The AI assistant could not answer. Try again.",
					},
				});
			}
			ctrl.close();
		},
	});
	return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
}
