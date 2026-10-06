/**
 * Console sign-in: one shared password (CONSOLE_PASSWORD), then an HMAC-signed session
 * cookie. The console can capture and refund PayPal payments, so every console route
 * checks it.
 */
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { signLink, verifyLink } from "@/src/crypto";
import { clientIp, HttpError, rateLimit } from "@/src/merchant/api/http";

const COOKIE = "ab_console";
const WEEK_S = 7 * 24 * 3600;

/** A session token: expiry (unix seconds) plus an HMAC over it. */
export const consoleToken = (expSeconds: number) => `${expSeconds}.${signLink(`console:${expSeconds}`)}`;

export function validConsoleToken(token: string, nowSeconds = Date.now() / 1000): boolean {
	const [exp, sig] = token.split(".");
	return /^\d+$/.test(exp ?? "") && Number(exp) > nowSeconds && verifyLink(`console:${exp}`, sig);
}

export async function consoleAuthorized(): Promise<boolean> {
	return validConsoleToken((await cookies()).get(COOKIE)?.value ?? "");
}

export async function requireConsole(): Promise<void> {
	if (!(await consoleAuthorized()))
		throw new HttpError(401, { name: "UNAUTHORIZED", message: "Sign in to the console" });
}

/**
 * The hosted demo lets anyone in with one click (CONSOLE_DEMO_OPEN=true): judges must be able to test
 * without restriction, and it is all PayPal sandbox money. A real merchant install keeps the password.
 */
export const demoConsoleOpen = () => process.env.CONSOLE_DEMO_OPEN === "true";

/**
 * Ship, cancel and refund: signed in, and bounded per visitor and overall, since on the demo anyone
 * may be signed in.
 */
export async function requireConsoleAction(req: Request): Promise<void> {
	await requireConsole();
	rateLimit("console-act:all", { capacity: 120, refillPerSec: 1 });
	rateLimit(`console-act:ip:${clientIp(req)}`, { capacity: 20, refillPerSec: 1 / 6 });
}

export function passwordMatches(given: string): boolean {
	const want = process.env.CONSOLE_PASSWORD ?? "";
	if (want.length < 8) return false; // refuse to run with no or a trivial password
	const a = Buffer.from(given);
	const b = Buffer.from(want);
	return a.length === b.length && timingSafeEqual(a, b);
}

export async function startConsoleSession(): Promise<void> {
	(await cookies()).set(COOKIE, consoleToken(Math.floor(Date.now() / 1000) + WEEK_S), {
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: WEEK_S,
	});
}
