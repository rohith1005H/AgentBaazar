/**
 * PayPal redirects the buyer here after the approval step (experience_context.return_url),
 * appending ?token=<order id>&PayerID=<payer id>. We confirm the approval with PayPal and
 * record it on the cart (the query string itself is not trusted), then reassure the human.
 */
import { log } from "@/src/log";
import { recordBuyerApproval } from "@/src/merchant/cart/service";

export async function GET(req: Request) {
	const q = new URL(req.url).searchParams;
	const [store, cartId, token] = [q.get("store"), q.get("cart_id"), q.get("token")];
	if (store && cartId && token)
		await recordBuyerApproval(store, cartId, token).catch((e) =>
			log.warn({ cartId, err: (e as Error).message }, "could not confirm approval on return"),
		);
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment approved · AgentBaazar</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5">
<h1 style="font-size:1.5rem">Payment approved</h1><p>You approved the payment in PayPal. Nothing has been charged yet: the store captures the payment when your order ships.</p><p>You can close this tab and go back to your shopping agent.</p></body></html>`;
	return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
