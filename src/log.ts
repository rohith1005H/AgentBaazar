import pino from "pino";

/** Structured JSON logs. Never log tokens, secrets, card data, or buyer addresses. */
export const log = pino({
	level: process.env.LOG_LEVEL ?? "info",
	base: { app: "agentbaazar" },
	redact: ["*.authorization", "*.Authorization", "*.client_secret", "*.access_token"],
});
