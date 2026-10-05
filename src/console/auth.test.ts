import { beforeAll, describe, expect, it } from "vitest";

describe("console session token", () => {
	beforeAll(() => {
		process.env.APP_SECRET = "b".repeat(64);
	});

	it("accepts its own unexpired token and nothing else", async () => {
		const { consoleToken, validConsoleToken } = await import("./auth");
		const now = 1_800_000_000;
		const token = consoleToken(now + 60);
		expect(validConsoleToken(token, now)).toBe(true);
		expect(validConsoleToken(token, now + 61)).toBe(false); // expired
		expect(validConsoleToken(token.replace(/^\d+/, String(now + 9_999)), now)).toBe(false); // expiry edited
		expect(validConsoleToken(`${now + 60}.${"A".repeat(22)}`, now)).toBe(false); // forged signature
		expect(validConsoleToken("", now)).toBe(false);
		expect(validConsoleToken("garbage", now)).toBe(false);
	});
});
