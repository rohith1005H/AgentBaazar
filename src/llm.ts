/**
 * LLM selection by role. Everything here is on a no-card free tier.
 *
 *   LLM_BUYER_MODEL    first choice for the shopping agent loop   (default gemini-3.8-flash)
 *   LLM_CONSOLE_MODEL  first choice for console/Studio/ops agents (default gemini-3.5-flash-lite)
 *
 * Free tiers are flaky at busy hours (Gemini answers 503 "high demand" or 429), so each
 * role is a chain: when a model is overloaded or out of quota, the same call goes to the
 * next one. Daily quotas are per model, which is why the chain mixes models.
 */
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { type LanguageModelMiddleware, wrapLanguageModel } from "ai";
import { log } from "@/src/log";

export type LlmRole = "buyer" | "console";

const CHAINS: Record<LlmRole, string[]> = {
	buyer: [process.env.LLM_BUYER_MODEL || "gemini-3.8-flash", "gemini-3.5-flash-lite", "groq:openai/gpt-oss-120b"],
	console: [process.env.LLM_CONSOLE_MODEL || "gemini-3.5-flash-lite", "gemini-3.8-flash", "groq:openai/gpt-oss-120b"],
};

function model(id: string) {
	if (id.startsWith("groq:")) return createGroq({ apiKey: process.env.GROQ_API_KEY })(id.slice(5));
	return createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })(id);
}

/** Overloaded, rate limited or out of quota: worth trying another model. */
function busy(e: unknown): boolean {
	const status = (e as { statusCode?: number }).statusCode;
	if (status === 429 || status === 500 || status === 503 || status === 529) return true;
	return /high demand|overloaded|quota|exhausted|unavailable|rate limit/i.test(String((e as Error)?.message ?? e));
}

const fallbackTo = (next: ReturnType<typeof model>, from: string): LanguageModelMiddleware => ({
	wrapGenerate: async ({ doGenerate, params }) => {
		try {
			return await doGenerate();
		} catch (e) {
			if (!busy(e)) throw e;
			log.warn({ from, to: next.modelId, err: String((e as Error).message).slice(0, 120) }, "LLM busy, falling back");
			return next.doGenerate(params);
		}
	},
	wrapStream: async ({ doStream, params }) => {
		try {
			return await doStream();
		} catch (e) {
			if (!busy(e)) throw e;
			log.warn({ from, to: next.modelId, err: String((e as Error).message).slice(0, 120) }, "LLM busy, falling back");
			return next.doStream(params);
		}
	},
});

export function llm(role: LlmRole) {
	const ids = CHAINS[role].filter((id) => !id.startsWith("groq:") || process.env.GROQ_API_KEY);
	// fold from the last: a -> (b -> c)
	return ids
		.slice(0, -1)
		.reduceRight(
			(next, id) => wrapLanguageModel({ model: model(id), middleware: fallbackTo(next, id) }),
			model(ids.at(-1)!),
		);
}
