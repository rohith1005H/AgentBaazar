/**
 * Pure helpers for the AG Studio <-> AI SDK bridge (/api/console/studio-llm).
 */
import type { AgAiConversationItem, AgAiToolCall, AgLlmRequest } from "ag-studio";
import type { ModelMessage, ToolChoice, ToolSet } from "ai";

export type Json = Record<string, unknown>;
// Our extra field on function_call items: Studio pushes output items back into history unchanged
// within a run, so Gemini 3's thought signature survives the round trip.
export type SignedCall = AgAiToolCall & { thoughtSignature?: string };

export function toToolChoice(c: AgLlmRequest["toolChoice"]): ToolChoice<ToolSet> | undefined {
	if (!c) return undefined;
	return typeof c === "string" ? c : { type: "tool", toolName: c.name };
}

/** Studio history (OpenAI Responses-like items) -> AI SDK ModelMessage[]. */
export function toModelMessages(items: AgAiConversationItem[]): { messages: ModelMessage[]; system: string[] } {
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
export function clean(s: Json): Json {
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
