import { defineConfig } from "drizzle-kit";

export default defineConfig({
	schema: "./src/db/schema.ts",
	out: "./src/db/migrations",
	dialect: "postgresql",
	casing: "snake_case",
	schemaFilter: ["merchant", "platform"],
	dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
