/**
 * LLM selection by role. Everything here is on a no-card free tier.
 *
 *   LLM_BUYER_MODEL    first choice for the shopping agent loop   (default gemini-3.5-flash-lite)
 *   LLM_CONSOLE_MODEL  first choice for console/Studio/ops agents (default gemma-4-26b-a4b-it)
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

// Free-tier quotas are per model, so each role is a chain across models (measured 2026-10-05:
// tool-calling step latency; gemini-3.8-flash allows only 20 requests a day, 3.7-flash hung).
// The console chain has no Groq: its free 8k tokens/minute cannot hold one Studio turn.
const CHAINS: Record<LlmRole, string[]> = {
	buyer: [
		process.env.LLM_BUYER_MODEL || "gemini-3.5-flash-lite", // ~1 s per step
		"gemini-3.6-flash", // ~4 s
		"gemma-4-26b-a4b-it", // ~3.5 s
		"groq:openai/gpt-oss-120b",
	],
	// A console request fans out into ~10 model calls a minute; Gemini 3.6 Flash allows 5 a
	// minute free, so lead with Gemma 4 and spread the rest across models.
	console: [
		process.env.LLM_CONSOLE_MODEL || "gemma-4-26b-a4b-it",
		"gemma-4-31b-it",
		"gemini-3.6-flash",
		"gemini-3.1-flash-lite",
		"gemini-3.5-flash-lite",
	],
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

/**
 * After a model refuses, skip it instead of waiting for it to refuse again on every step.
 * Gemini says how long ("Please retry in 12.8s", "in 10h41m45s" for the daily cap); use
 * that, else a minute. ponytail: per-instance memory; fine for one Render instance.
 */
const restingUntil = new Map<string, number>();
const resting = (id: string) => (restingUntil.get(id) ?? 0) > Date.now();

export function retryAfterMs(message: string): number {
	const m = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(message);
	if (!m || !(m[1] || m[2] || m[3])) return 60_000;
	const ms = ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000;
	return Math.min(Math.max(ms, 5_000), 12 * 3_600_000);
}

function rest(id: string, e: unknown) {
	const message = String((e as Error)?.message ?? e);
	const ms = retryAfterMs(message);
	restingUntil.set(id, Date.now() + ms);
	const metric = /metric: ([\w./-]+), limit: (\d+)/.exec(message);
	log.warn(
		{ from: id, restSeconds: Math.round(ms / 1000), metric: metric?.[1], limit: metric?.[2] },
		"LLM busy, falling back",
	);
}

/** How long a call may wait for a model to come off cooldown before giving up. */
const MAX_WAIT_MS: Record<LlmRole, number> = { buyer: 20_000, console: 45_000 };

/**
 * Treat the chain as a pool: call the first model that is not cooling down; if it refuses
 * for quota or load, rest it and try the next; if every model is resting, wait for the
 * soonest one (bounded) and go round again.
 */
async function pooled<T>(
	role: LlmRole,
	chain: ReturnType<typeof model>[],
	call: (m: ReturnType<typeof model>) => PromiseLike<T>,
) {
	for (let round = 0; round < 3; round++) {
		for (const m of chain) {
			if (resting(m.modelId)) continue;
			try {
				return await call(m);
			} catch (e) {
				if (!busy(e)) throw e;
				rest(m.modelId, e);
			}
		}
		const soonest = Math.min(...chain.map((m) => restingUntil.get(m.modelId) ?? 0)) - Date.now();
		if (soonest > MAX_WAIT_MS[role]) break;
		await new Promise((r) => setTimeout(r, Math.max(soonest, 1_000)));
	}
	throw new Error("All free AI models are busy (rate limit); try again in a minute");
}

export function llm(role: LlmRole) {
	const chain = CHAINS[role].filter((id) => !id.startsWith("groq:") || process.env.GROQ_API_KEY).map(model);
	const pool: LanguageModelMiddleware = {
		wrapGenerate: ({ params }) => pooled(role, chain, (m) => m.doGenerate(params)),
		wrapStream: ({ params }) => pooled(role, chain, (m) => m.doStream(params)),
	};
	return wrapLanguageModel({ model: chain[0], middleware: pool });
}
