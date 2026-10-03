/**
 * PayPal redirects the buyer here after the approval step (experience_context.cancel_url).
 * PayPal appends ?token=<order id>&PayerID=<payer id> on approval.
 * The buyer agent learns about approval by polling the order; this page only reassures the human.
 */
export async function GET() {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment cancelled · AgentBaazar</title></head>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1.5rem;line-height:1.5">
<h1 style="font-size:1.5rem">Payment cancelled</h1><p>You cancelled the PayPal approval. Nothing was charged. Your shopping agent can offer other options.</p></body></html>`;
	return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
