/**
 * Shared plumbing for every merchant-side route handler:
 *   - a request id on every response (X-AgentBaazar-Request-Id) and in every error's debug_id
 *   - errors in PayPal's own envelope { name, message, debug_id, details[] }
 *   - JWT verification for agent-facing routes (the Store Sync contract)
 *   - a per-caller rate limit
 */
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import type { ApiError } from "@/src/cart-spec/schema";
import { log } from "@/src/log";
import { AuthError, type CartCaller, verifyCartJwt } from "@/src/merchant/auth/jwt-verify";
import { PayPalError } from "@/src/merchant/paypal/http";

export class HttpError extends Error {
	constructor(
		public readonly status: number,
		public readonly body: Omit<ApiError, "debug_id">,
		public readonly headers: Record<string, string> = {},
	) {
		super(body.message);
	}
}

export const badRequest = (message: string, field?: string, issue = "INVALID_REQUEST") =>
	new HttpError(400, {
		name: "INVALID_REQUEST",
		message,
		details: field ? [{ field, issue, description: message }] : undefined,
	});

export const notFound = (name: string, message: string) => new HttpError(404, { name, message });

export const unprocessable = (message: string, details: ApiError["details"] = []) =>
	new HttpError(422, { name: "UNPROCESSABLE_ENTITY", message, details });

export type ApiResult = { status: number; body: unknown; headers?: Record<string, string> };

type Ctx<P> = { params: Promise<P> };
type Handler<P> = (a: { req: Request; params: P; requestId: string }) => Promise<ApiResult>;
type AuthedHandler<P> = (a: { req: Request; params: P; requestId: string; caller: CartCaller }) => Promise<ApiResult>;

/** Public route (no caller auth), e.g. catalog search. */
export function route<P>(handler: Handler<P>) {
	return async (req: Request, ctx: Ctx<P>): Promise<Response> => {
		const requestId = randomUUID();
		try {
			const params = await ctx.params;
			const r = await handler({ req, params, requestId });
			return respond(r.status, r.body, requestId, r.headers);
		} catch (e) {
			return failure(e, requestId, req);
		}
	};
}

/** Agent-facing store route: verifies the platform JWT against the store id in the path. */
export function storeRoute<P extends { store: string }>(handler: AuthedHandler<P>) {
	return route<P>(async ({ req, params, requestId }) => {
		const caller = await verifyCartJwt(req.headers.get("authorization"), params.store);
		limit(`${params.store}:${caller.subject}`);
		return handler({ req, params, requestId, caller });
	});
}

/** Admin route for the merchant's own tools (console, scripts): bearer STORE_ADMIN_TOKEN. */
export function adminRoute<P>(handler: Handler<P>) {
	return route<P>(async (a) => {
		const want = process.env.STORE_ADMIN_TOKEN;
		const got = a.req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
		if (!want || got !== want) throw new AuthError("Admin token required");
		return handler(a);
	});
}

export async function readJson(req: Request): Promise<unknown> {
	try {
		return await req.json();
	} catch {
		throw new HttpError(400, { name: "MALFORMED_REQUEST", message: "Request body is not valid JSON" });
	}
}

function respond(status: number, body: unknown, requestId: string, headers: Record<string, string> = {}) {
	return Response.json(body, { status, headers: { "X-AgentBaazar-Request-Id": requestId, ...headers } });
}

function failure(e: unknown, requestId: string, req: Request): Response {
	const where = { requestId, method: req.method, path: new URL(req.url).pathname };
	if (e instanceof HttpError) {
		if (e.status >= 500) log.error({ ...where, err: e }, e.message);
		return respond(e.status, { ...e.body, debug_id: requestId }, requestId, e.headers);
	}
	if (e instanceof AuthError) {
		log.warn({ ...where, reason: e.message }, "auth rejected");
		return respond(
			e.status,
			{ name: e.status === 403 ? "FORBIDDEN" : "UNAUTHORIZED", message: e.message, debug_id: requestId },
			requestId,
		);
	}
	if (e instanceof ZodError) {
		return respond(
			400,
			{
				name: "INVALID_REQUEST",
				message: "Request does not match the Cart API schema",
				debug_id: requestId,
				details: e.issues.slice(0, 20).map((i) => ({
					field: i.path
						.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
						.join("")
						.replace(/^\./, ""),
					issue: i.code.toUpperCase(),
					description: i.message,
				})),
			},
			requestId,
		);
	}
	if (e instanceof PayPalError) {
		log.error(
			{ ...where, paypal: { status: e.status, name: e.name, debugId: e.debugId, issue: e.issue } },
			"PayPal error",
		);
		return respond(
			502,
			{
				name: "PAYMENT_PROCESSOR_ERROR",
				message: "PayPal could not complete the request",
				debug_id: requestId,
				details: [
					{ field: "payment_method", issue: e.issue ?? e.name, description: `PayPal debug_id ${e.debugId ?? "n/a"}` },
				],
			},
			requestId,
		);
	}
	log.error({ ...where, err: e }, "unhandled error");
	return respond(500, { name: "INTERNAL_SERVER_ERROR", message: "Unexpected error", debug_id: requestId }, requestId);
}

// ---- rate limit -----------------------------------------------------------

// ponytail: in-memory token bucket per caller on a single instance; move to Redis/Postgres if we ever scale out.
const BUCKET = { capacity: 60, refillPerSec: 1 };
const buckets = new Map<string, { tokens: number; at: number }>();

function limit(key: string) {
	const now = Date.now();
	const b = buckets.get(key) ?? { tokens: BUCKET.capacity, at: now };
	b.tokens = Math.min(BUCKET.capacity, b.tokens + ((now - b.at) / 1000) * BUCKET.refillPerSec);
	b.at = now;
	if (b.tokens < 1) {
		buckets.set(key, b);
		throw new HttpError(429, { name: "RATE_LIMIT_REACHED", message: "Too many requests" }, { "Retry-After": "1" });
	}
	b.tokens -= 1;
	buckets.set(key, b);
}
