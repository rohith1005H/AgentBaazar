/** GET /api/stores/{store}/agentic/search?q=&max_price=&limit= — public catalog search for agents */
import { route } from "@/src/merchant/api/http";
import { searchCatalog } from "@/src/merchant/discovery";

export const GET = route<{ store: string }>(async ({ req, params }) =>
	searchCatalog(params.store, new URL(req.url).searchParams),
);
