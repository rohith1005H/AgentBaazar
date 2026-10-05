import type { AgAiConversationItem, AgAiOutputItem, AgAiToolCall, AgLlmRequest, AgLlmResponse } from "ag-studio";
import { jsonSchema, type ModelMessage, streamText, type ToolChoice, type ToolSet } from "ai";
import { consoleAuthorized } from "@/src/console/auth";
import type { StudioLlmFrame } from "@/src/console/llm-adapter";
import { llm } from "@/src/llm";
import { log } from "@/src/log";

export const runtime = "nodejs";

type Json = Record<string, unknown>;
// Our extra field on function_call items: Studio pushes output items back into history unchanged
// within a run, so Gemini 3's thought signature survives the round trip.
type SignedCall = AgAiToolCall & { thoughtSignature?: string };

export async function POST(req: Request): Promise<Response> {
	if (!(await consoleAuthorized())) return new Response("Sign in to the console", { status: 401 });
	const raw = await req.text();
	const body = JSON.parse(raw) as AgLlmRequest;
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

function toToolChoice(c: AgLlmRequest["toolChoice"]): ToolChoice<ToolSet> | undefined {
	if (!c) return undefined;
	return typeof c === "string" ? c : { type: "tool", toolName: c.name };
}

/** Studio history (OpenAI Responses-like items) -> AI SDK ModelMessage[]. */
function toModelMessages(items: AgAiConversationItem[]): { messages: ModelMessage[]; system: string[] } {
	const messages: ModelMessage[] = [];
	const system: string[] = [];
	const toolNames = new Map<string, string>();
	for (const item of items) {
		const last = messages.at(-1);
		if (item.type === "message" && item.kind === "input") {
			const t = item.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");
			if (item.role === "system") system.push(t);
			else messages.push({ role: "user", content: t });
		} else if (item.type === "message") {
			const t = item.content.map((c) => (c.type === "text" ? c.text : c.refusal)).join("");
			if (last?.role === "assistant" && Array.isArray(last.content)) last.content.push({ type: "text", text: t });
			else messages.push({ role: "assistant", content: [{ type: "text", text: t }] });
		} else if (item.type === "function_call") {
			toolNames.set(item.callId, item.name);
			const sig = (item as SignedCall).thoughtSignature;
			const part = {
				type: "tool-call" as const,
				toolCallId: item.callId,
				toolName: item.name,
				input: safeParse(item.arguments),
				...(sig ? { providerOptions: { google: { thoughtSignature: sig } } } : {}),
			};
			if (last?.role === "assistant" && Array.isArray(last.content)) last.content.push(part);
			else messages.push({ role: "assistant", content: [part] });
		} else if (item.type === "function_call_output") {
			const part = {
				type: "tool-result" as const,
				toolCallId: item.callId,
				toolName: toolNames.get(item.callId) ?? "unknown",
				output: { type: "text" as const, value: item.output },
			};
			if (last?.role === "tool") last.content.push(part);
			else messages.push({ role: "tool", content: [part] });
		}
		// reasoning items: dropped (Gemini re-derives; the signature rides on the call)
	}
	return { messages, system };
}

function safeParse(s: string): unknown {
	try {
		return JSON.parse(s || "{}");
	} catch {
		return {};
	}
}

/**
 * Studio emits JSON Schema 2020-12 ($ref/$defs, anyOf, `{ not: {} }` "undefined" branches). Gemini accepts
 * $ref/$defs but rejects a recursive $ref through a required non-empty array (create_plan's layout tree),
 * so: drop `minItems`, drop `not` branches, const -> enum. Studio re-validates args, so loosening is safe.
 */
function clean(s: Json): Json {
	const out: Json = {};
	for (const [k, v] of Object.entries(s)) {
		if (k === "minItems") continue;
		if (k === "anyOf" && Array.isArray(v)) {
			const kept = v
				.filter((b) => !(b && typeof b === "object" && "not" in b && Object.keys(b).length === 1))
				.map((b) => clean(b as Json));
			if (kept.length === 1) Object.assign(out, kept[0]);
			else out.anyOf = kept;
		} else if (k === "const") out.enum = [v];
		else if (Array.isArray(v)) out[k] = v.map((x) => (x && typeof x === "object" ? clean(x as Json) : x));
		else if (v && typeof v === "object") out[k] = clean(v as Json);
		else out[k] = v;
	}
	return out;
}
