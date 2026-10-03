/**
 * POST /api/paypal/webhooks — PayPal webhook listener (one per PayPal app,
 * shared by the stores that app serves). Signature-verified; see src/merchant/webhooks.ts.
 */
import { route } from "@/src/merchant/api/http";
import { handleWebhook } from "@/src/merchant/webhooks";

export const POST = route(async ({ req }) => handleWebhook(req));
