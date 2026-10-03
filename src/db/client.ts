/**
 * Postgres client. Neon's WebSocket `Pool` gives us interactive transactions
 * (checkout reserves stock and records the order atomically). The pool is
 * created lazily so importing this module never needs DATABASE_URL (e.g. during
 * `next build`), and cached on globalThis so dev hot-reloads reuse it.
 * Idle connections close after 10 s so Neon can still scale to zero.
 */
import { Pool } from "@neondatabase/serverless";
import { drizzle, type NeonDatabase } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";

export type Db = NeonDatabase<typeof schema>;
/** A transaction handle has the same query surface as the db itself. */
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const g = globalThis as unknown as { __abDb?: { db: Db; pool: Pool } };

function init() {
	const url = process.env.DATABASE_URL;
	if (!url) throw new Error("DATABASE_URL is not set");
	const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 10_000 });
	return { db: drizzle({ client: pool, schema, casing: "snake_case" }), pool };
}

export function db(): Db {
	g.__abDb ??= init();
	return g.__abDb.db;
}

/** Scripts call this before exiting so the process does not hang on open sockets. */
export async function closeDb(): Promise<void> {
	await g.__abDb?.pool.end();
	g.__abDb = undefined;
}
