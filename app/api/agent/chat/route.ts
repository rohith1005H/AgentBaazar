/**
 * The buyer agent's chat endpoint (AI SDK UI message stream).
 *
 * Public, so it is bounded: a session cookie is required, turns are rate limited per
 * session and per IP (free-tier LLM quota), and the history the browser sends is capped.
 */
import { createAgentUIStreamResponse } from "ai";
import { log } from "@/src/log";
import { HttpError, rateLimit } from "@/src/merchant/api/http";
import { currentSession } from "@/src/platform/agent/session";
import { dropUnansweredToolCalls, shopper } from "@/src/platform/agent/shopper";

const MAX_BODY = 400_000;
const MAX_MESSAGES = 80;

export async function POST(req: Request) {
	try {
		const raw = await req.text();
		if (raw.length > MAX_BODY)
			throw new HttpError(413, { name: "TOO_LARGE", message: "Conversation too long; start a new chat" });
		const { messages } = JSON.parse(raw) as { messages?: unknown[] };
		if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES)
			throw new HttpError(400, { name: "INVALID_REQUEST", message: "messages must be a non-empty array (max 80)" });

		const session = await currentSession({ create: false });
		const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
		rateLimit(`agent:session:${session.id}`, { capacity: 15, refillPerSec: 1 / 20 });
		rateLimit(`agent:ip:${ip}`, { capacity: 40, refillPerSec: 1 / 10 });

		return createAgentUIStreamResponse({
			agent: shopper(session),
			uiMessages: dropUnansweredToolCalls(messages),
			onError: (e) => {
				const msg = e instanceof Error ? e.message : String(e);
				log.error({ session: session.id.slice(0, 6), err: msg.slice(0, 300) }, "agent turn failed");
				return /quota|rate|429|exhausted/i.test(msg)
					? "The free AI quota is busy right now. Please try again in a minute."
					: "Something went wrong on my side. Please try again.";
			},
		});
	} catch (e) {
		if (e instanceof HttpError) return Response.json(e.body, { status: e.status, headers: e.headers });
		if (e instanceof SyntaxError)
			return Response.json({ name: "INVALID_REQUEST", message: "Body is not JSON" }, { status: 400 });
		throw e;
	}
}
