/** POST from the console sign-in form. */
import { passwordMatches, startConsoleSession } from "@/src/console/auth";
import { HttpError, rateLimit } from "@/src/merchant/api/http";

export async function POST(req: Request) {
	const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
	try {
		rateLimit(`console-login:${ip}`, { capacity: 5, refillPerSec: 1 / 30 });
	} catch (e) {
		if (e instanceof HttpError) return Response.redirect(new URL("/console/login?error=wait", req.url), 303);
		throw e;
	}
	const form = await req.formData();
	if (!passwordMatches(String(form.get("password") ?? "")))
		return Response.redirect(new URL("/console/login?error=password", req.url), 303);
	await startConsoleSession();
	return Response.redirect(new URL("/console", req.url), 303);
}
