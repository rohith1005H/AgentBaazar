import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig } from "vitest/config";

// Only the test database URL is taken from .env.local; tests never see real credentials.
const local = existsSync(".env.local") ? parseEnv(readFileSync(".env.local", "utf8")) : {};

export default defineConfig({
	resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
	test: {
		include: ["src/**/*.test.ts"],
		environment: "node",
		env: local.TEST_DATABASE_URL ? { TEST_DATABASE_URL: local.TEST_DATABASE_URL } : {},
		testTimeout: 30_000,
		hookTimeout: 60_000,
	},
});
