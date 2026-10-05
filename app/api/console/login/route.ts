/** POST from the console sign-in form. */
import { passwordMatches, startConsoleSession } from "@/src/console/auth";
import { HttpError, rateLimit } from "@/src/merchant/api/http";

// Relative Location: behind Render's proxy req.url carries the internal host (localhost:10000).
const seeOther = (path: string) => new Response(null, { status: 303, headers: { Location: path } });

export async function POST(req: Request) {
	const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local";
	try {
		rateLimit(`console-login:${ip}`, { capacity: 5, refillPerSec: 1 / 30 });
	} catch (e) {
		if (e instanceof HttpError) return seeOther("/console/login?error=wait");
		throw e;
	}
	const form = await req.formData().catch(() => null);
	if (!form || !passwordMatches(String(form.get("password") ?? ""))) return seeOther("/console/login?error=password");
	await startConsoleSession();
	return seeOther("/console");
}
