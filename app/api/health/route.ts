/**
 * GET /api/health — shallow by default so uptime pingers never wake the database
 * (Neon scales to zero). `?deep=1` also checks the database.
 */
import { sql } from "drizzle-orm";
import { db } from "@/src/db/client";

export async function GET(req: Request) {
	if (new URL(req.url).searchParams.get("deep") !== "1") return Response.json({ ok: true });
	const started = Date.now();
	await db().execute(sql`select 1`);
	return Response.json({ ok: true, db_ms: Date.now() - started });
}
