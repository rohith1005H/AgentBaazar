import type { AgAiConversationItem } from "ag-studio";
import { describe, expect, it } from "vitest";
import { clean, toModelMessages, toToolChoice } from "./studio-bridge";

describe("studio bridge", () => {
	it("cleans Studio's JSON Schema for Gemini without losing structure", () => {
		const schema = {
			type: "object",
			properties: {
				children: { type: "array", minItems: 1, items: { $ref: "#/$defs/Node" } },
				mode: { const: "grid" },
				maybe: { anyOf: [{ type: "string" }, { not: {} }] },
				either: { anyOf: [{ type: "string" }, { type: "number" }] },
			},
			$defs: { Node: { type: "object", properties: { id: { type: "string", minItems: 2 } } } },
		};
		expect(clean(schema)).toEqual({
			type: "object",
			properties: {
				children: { type: "array", items: { $ref: "#/$defs/Node" } },
				mode: { enum: ["grid"] },
				maybe: { type: "string" },
				either: { anyOf: [{ type: "string" }, { type: "number" }] },
			},
			$defs: { Node: { type: "object", properties: { id: { type: "string" } } } },
		});
	});

	it("turns Studio history into model messages and keeps Gemini's thought signature", () => {
		const items = [
			{ kind: "input", type: "message", role: "system", content: [{ type: "text", text: "Be brief." }] },
			{ kind: "input", type: "message", role: "user", content: [{ type: "text", text: "Add a donut" }] },
			{
				kind: "output",
				type: "function_call",
				callId: "c1",
				name: "add_widget",
				arguments: '{"type":"donut-chart"}',
				thoughtSignature: "sig-1",
			},
			{ type: "function_call_output", callId: "c1", output: "Added" },
			{
				kind: "output",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Done.", annotations: [] }],
			},
		] as unknown as AgAiConversationItem[];
		const { messages, system } = toModelMessages(items);
		expect(system).toEqual(["Be brief."]);
		expect(messages).toEqual([
			{ role: "user", content: "Add a donut" },
			{
				role: "assistant",
				content: [
					{
						type: "tool-call",
						toolCallId: "c1",
						toolName: "add_widget",
						input: { type: "donut-chart" },
						providerOptions: { google: { thoughtSignature: "sig-1" } },
					},
				],
			},
			{
				role: "tool",
				content: [
					{ type: "tool-result", toolCallId: "c1", toolName: "add_widget", output: { type: "text", value: "Added" } },
				],
			},
			{ role: "assistant", content: [{ type: "text", text: "Done." }] },
		]);
		expect(toToolChoice({ name: "add_widget" })).toEqual({ type: "tool", toolName: "add_widget" });
		expect(toToolChoice(undefined)).toBeUndefined();
	});
});
