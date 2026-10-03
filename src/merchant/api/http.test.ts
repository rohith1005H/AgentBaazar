import { afterEach, describe, expect, it, vi } from "vitest";
import { setLocalJwks } from "@/src/merchant/auth/jwt-verify";
import { generateSigningKey, jwks, signCartJwt } from "@/src/platform/stores/jwt-sign";

vi.mock("@/src/merchant/cart/repo", () => ({
	getMerchant: async (id: string) =>
		({
			"patel-textiles": { id: "patel-textiles", paypalMerchantId: "NCW3CJ87H5GGQ" },
			"lumen-ceramics": { id: "lumen-ceramics", paypalMerchantId: null },
		})[id],
}));

const { adminRoute, storeRoute } = await import("./http");

const ctx = (store: string) => ({ params: Promise.resolve({ store }) });
const handler = storeRoute<{ store: string }>(async ({ merchant, caller }) => ({
	status: 200,
	body: { store: merchant.id, caller: caller.merchantId },
}));

async function call(store: string, merchantClaim: string) {
	const key = await generateSigningKey();
	setLocalJwks(jwks([key]));
	const token = await signCartJwt(key, merchantClaim, "https://platform.test");
	const req = new Request(`https://x.test/api/stores/${store}/paypal/v1/merchant-cart`, {
		method: "POST",
		headers: { Authorization: `Bearer ${token}` },
	});
	return handler(req, ctx(store));
}

describe("storeRoute binds the token to the store", () => {
	afterEach(() => setLocalJwks(undefined));

	it("accepts a token for this store by store id or by PayPal merchant id", async () => {
		expect((await call("patel-textiles", "patel-textiles")).status).toBe(200);
		expect((await call("patel-textiles", "NCW3CJ87H5GGQ")).status).toBe(200);
	});

	it("rejects a valid token issued for another merchant with 403", async () => {
		const res = await call("lumen-ceramics", "patel-textiles");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ name: "FORBIDDEN" });
		expect(res.headers.get("X-AgentBaazar-Request-Id")).toBeTruthy();
	});

	it("404s an unknown store", async () => {
		expect((await call("nope", "nope")).status).toBe(404);
	});
});

describe("adminRoute", () => {
	it("compares the admin token in constant time and rejects anything else", async () => {
		vi.stubEnv("STORE_ADMIN_TOKEN", "0123456789abcdef0123456789abcdef");
		const admin = adminRoute(async () => ({ status: 200, body: { ok: true } }));
		const req = (auth?: string) =>
			new Request("https://x.test/api/admin", { method: "POST", headers: auth ? { Authorization: auth } : {} });
		expect((await admin(req("Bearer 0123456789abcdef0123456789abcdef"), ctx("x"))).status).toBe(200);
		expect((await admin(req("Bearer wrong"), ctx("x"))).status).toBe(401);
		expect((await admin(req(), ctx("x"))).status).toBe(401);
		vi.unstubAllEnvs();
	});
});
