/** POST /api/stores/{store}/mcp — the store's MCP server (Streamable HTTP, stateless). See src/merchant/mcp.ts. */
import { clientIp, HttpError, rateLimit } from "@/src/merchant/api/http";
import { getMerchant } from "@/src/merchant/cart/repo";
import { storeMcp } from "@/src/merchant/mcp";

const MAX_BODY = 64_000;
// One handler per real store (only created after the store is found), so the map stays small.
const handlers = new Map<string, ReturnType<typeof storeMcp>>();

async function handle(req: Request, ctx: { params: Promise<{ store: string }> }) {
	try {
		if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY)
			throw new HttpError(413, { name: "TOO_LARGE", message: "Request too large" });
		// Widest first. Tools hit the database and PayPal, not the LLM quota, so these are roomier
		// than the chat agent's limits.
		rateLimit("mcp:all", { capacity: 600, refillPerSec: 10 });
		rateLimit(`mcp:ip:${clientIp(req)}`, { capacity: 120, refillPerSec: 1 });
		const { store } = await ctx.params;
		let handler = handlers.get(store);
		if (!handler) {
			const m = await getMerchant(store);
			if (!m) throw new HttpError(404, { name: "STORE_NOT_FOUND", message: `Store '${store}' does not exist` });
			handler = storeMcp(m);
			handlers.set(store, handler);
		}
		return await handler(req);
	} catch (e) {
		if (e instanceof HttpError) return Response.json(e.body, { status: e.status, headers: e.headers });
		throw e;
	}
}

export { handle as GET, handle as POST, handle as DELETE };
