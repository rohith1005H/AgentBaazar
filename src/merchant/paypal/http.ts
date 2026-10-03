/**
 * Thin PayPal REST layer used for everything the server SDK does not cover
 * (tracking, webhook verification, catalog) and for minting tokens.
 *
 * Conventions enforced here, matching PayPal's own integration checklist:
 *   - client-credentials token cached until shortly before expiry
 *   - `PayPal-Request-Id` on every POST/PATCH (caller supplies a stable id per logical action)
 *   - `debug_id` from every error body surfaced in the thrown error
 *   - 429 and 5xx retried with jittered exponential backoff
 */
import { randomUUID } from "node:crypto";

export type PayPalCreds = { clientId: string; clientSecret: string };

export const PAYPAL_BASE =
	process.env.PAYPAL_ENV === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
	constructor(
		public readonly status: number,
		public readonly name: string,
		message: string,
		public readonly debugId?: string,
		public readonly details?: unknown,
	) {
		super(message);
	}
	/** First `details[].issue`, e.g. INSTRUMENT_DECLINED, ORDER_NOT_APPROVED */
	get issue(): string | undefined {
		const d = this.details as { issue?: string }[] | undefined;
		return d?.[0]?.issue;
	}
}

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function accessToken(creds: PayPalCreds): Promise<string> {
	const hit = tokenCache.get(creds.clientId);
	if (hit && hit.expiresAt > Date.now()) return hit.token;

	const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");
	const res = await fetch(`${PAYPAL_BASE}/v1/oauth2/token`, {
		method: "POST",
		headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
		body: "grant_type=client_credentials",
	});
	if (!res.ok) throw new PayPalError(res.status, "OAUTH_FAILED", await res.text());
	const body = (await res.json()) as { access_token: string; expires_in: number };
	// refresh 60 s early
	tokenCache.set(creds.clientId, { token: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 });
	return body.access_token;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type RequestOptions = {
	/** Idempotency key. Required for POST/PATCH; store it with the row so retries reuse it. */
	requestId?: string;
	headers?: Record<string, string>;
	/** `return=representation` to get full bodies back from PayPal */
	prefer?: string;
	retries?: number;
};

export async function paypal<T = unknown>(
	creds: PayPalCreds,
	method: Method,
	path: string,
	body?: unknown,
	opts: RequestOptions = {},
): Promise<{ status: number; data: T }> {
	const token = await accessToken(creds);
	const headers: Record<string, string> = {
		Authorization: `Bearer ${token}`,
		"Content-Type": "application/json",
		Accept: "application/json",
		...opts.headers,
	};
	if (method === "POST" || method === "PATCH") headers["PayPal-Request-Id"] = opts.requestId ?? randomUUID();
	if (opts.prefer) headers.Prefer = opts.prefer;

	const maxAttempts = (opts.retries ?? 3) + 1;
	let lastErr: unknown;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const res = await fetch(`${PAYPAL_BASE}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const text = await res.text();
		const data = text ? safeJson(text) : {};
		if (res.ok) return { status: res.status, data: data as T };

		const err = toError(res.status, data);
		lastErr = err;
		const retryable = res.status === 429 || res.status >= 500;
		if (!retryable || attempt === maxAttempts) throw err;
		await sleep(200 * 2 ** attempt + Math.random() * 200);
	}
	throw lastErr;
}

function toError(status: number, data: unknown): PayPalError {
	const d = (data ?? {}) as {
		name?: string;
		message?: string;
		debug_id?: string;
		details?: unknown;
		error?: string;
		error_description?: string;
	};
	return new PayPalError(
		status,
		d.name ?? d.error ?? `HTTP_${status}`,
		d.message ?? d.error_description ?? `PayPal returned ${status}`,
		d.debug_id,
		d.details,
	);
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return { message: text };
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Default merchant credentials from env (per-store overrides come from the DB). */
export function envCreds(): PayPalCreds {
	const clientId = process.env.PAYPAL_CLIENT_ID;
	const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
	if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET not set");
	return { clientId, clientSecret };
}
