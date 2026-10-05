/** The buyer's session (created on first visit): who the agent shops for, and their budget. */
import { log } from "@/src/log";
import { route } from "@/src/merchant/api/http";
import { currentSession } from "@/src/platform/agent/session";

export const GET = route(async ({ req }) => {
	// TEMP diagnostic: which client-IP headers this host provides (names and hop count only).
	log.info(
		{
			ipHeaders: ["cf-connecting-ip", "true-client-ip", "x-real-ip"].filter((h) => req.headers.has(h)),
			xffHops: req.headers.get("x-forwarded-for")?.split(",").length ?? 0,
		},
		"ip headers",
	);
	const s = await currentSession({ create: true });
	const a = s.profile.shipping_address;
	return {
		status: 200,
		body: {
			buyer: `${s.profile.name.given_name} ${s.profile.name.surname}`,
			ship_to: `${a.address_line_1}, ${a.admin_area_2}, ${a.admin_area_1} ${a.postal_code}`,
			budget: s.mandate ? `$${(s.mandate.max_total_cents / 100).toFixed(2)}` : null,
			deliver_by: s.mandate?.deliver_by ?? null,
		},
	};
});
