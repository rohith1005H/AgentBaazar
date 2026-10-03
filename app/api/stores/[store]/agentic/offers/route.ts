/** POST /api/stores/{store}/agentic/offers { cart_id, reason? } — policy-bounded offer for a cart */
import { readJson, storeRoute } from "@/src/merchant/api/http";
import { makeOffer } from "@/src/merchant/discovery";

export const POST = storeRoute<{ store: string }>(async ({ req, params }) =>
	makeOffer(params.store, await readJson(req)),
);
