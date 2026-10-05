/**
 * Console sign-in: one shared password (CONSOLE_PASSWORD), then an HMAC-signed session
 * cookie. The console can capture and refund PayPal payments, so every console route
 * checks it.
 */
import { timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { signLink, verifyLink } from "@/src/crypto";
import { HttpError } from "@/src/merchant/api/http";

const COOKIE = "ab_console";
const WEEK_S = 7 * 24 * 3600;

export async function consoleAuthorized(): Promise<boolean> {
	const [exp, sig] = ((await cookies()).get(COOKIE)?.value ?? "").split(".");
	return Number(exp) > Date.now() / 1000 && verifyLink(`console:${exp}`, sig);
}

export async function requireConsole(): Promise<void> {
	if (!(await consoleAuthorized()))
		throw new HttpError(401, { name: "UNAUTHORIZED", message: "Sign in to the console" });
}

export function passwordMatches(given: string): boolean {
	const want = process.env.CONSOLE_PASSWORD ?? "";
	if (want.length < 8) return false; // refuse to run with no or a trivial password
	const a = Buffer.from(given);
	const b = Buffer.from(want);
	return a.length === b.length && timingSafeEqual(a, b);
}

export async function startConsoleSession(): Promise<void> {
	const exp = Math.floor(Date.now() / 1000) + WEEK_S;
	(await cookies()).set(COOKIE, `${exp}.${signLink(`console:${exp}`)}`, {
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: WEEK_S,
	});
}
