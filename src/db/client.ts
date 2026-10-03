import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

/** Neon HTTP driver: stateless per query, fits scale-to-zero and serverless. */
export const db = drizzle({ client: neon(url), schema, casing: "snake_case" });
export type Db = typeof db;
