/**
 * LLM selection by role. Everything here is on a no-card free tier.
 *
 *   LLM_PROVIDER       google (default) | groq
 *   LLM_BUYER_MODEL    model for the shopping agent loop   (default gemini-3.8-flash)
 *   LLM_CONSOLE_MODEL  model for console/Studio/ops agents (default gemini-3.5-flash-lite)
 *
 * Daily free quotas are per model, so the two roles use different models on
 * purpose. Groq is a fallback for short-context tasks only (8K TPM free tier).
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import type { LanguageModel } from "ai";

export type LlmRole = "buyer" | "console";

const DEFAULTS: Record<string, Record<LlmRole, string>> = {
	google: { buyer: "gemini-3.8-flash", console: "gemini-3.5-flash-lite" },
	groq: { buyer: "openai/gpt-oss-120b", console: "openai/gpt-oss-20b" },
};

export function llm(role: LlmRole): LanguageModel {
	const provider = process.env.LLM_PROVIDER ?? "google";
	const envModel = role === "buyer" ? process.env.LLM_BUYER_MODEL : process.env.LLM_CONSOLE_MODEL;
	const model = envModel || DEFAULTS[provider]?.[role];
	if (!model) throw new Error(`No model configured for provider=${provider} role=${role}`);

	switch (provider) {
		case "google":
			return createGoogleGenerativeAI({ apiKey: required("GOOGLE_GENERATIVE_AI_API_KEY") })(model);
		case "groq":
			return createGroq({ apiKey: required("GROQ_API_KEY") })(model);
		default:
			throw new Error(`Unknown LLM_PROVIDER "${provider}" (expected google | groq)`);
	}
}

function required(name: string): string {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set`);
	return v;
}
