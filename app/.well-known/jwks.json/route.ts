/**
 * GET /.well-known/jwks.json — the platform's public signing keys.
 * Merchants verify Cart API calls against this (AGENTIC_JWKS_URL); for real
 * Store Sync they would point at https://www.paypal.ai/.well-known/jwks.json.
 */
import { publicJwks } from "@/src/platform/stores/keys";

export async function GET() {
	return Response.json(await publicJwks(), { headers: { "Cache-Control": "public, max-age=300" } });
}
