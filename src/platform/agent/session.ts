/**
 * A shopping session on the platform side: the buyer's saved profile, the spending
 * mandate they gave the agent, and the carts the agent opened for them.
 *
 * The session id lives in an httpOnly cookie and is never shown to the model. Every
 * cart the agent touches is checked against this session, so one buyer's agent can
 * never read or pay another buyer's cart.
 */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import type { Address, PayPalCart } from "@/src/cart-spec/schema";
import { db } from "@/src/db/client";
import { sessionCarts, sessions, stores } from "@/src/db/schema";
import { HttpError } from "@/src/merchant/api/http";

export const SESSION_COOKIE = "ab_session";

export type Mandate = { max_total_cents: number; deliver_by?: string };
export type Profile = {
	name: { given_name: string; surname: string };
	email_address: string;
	shipping_address: Address;
};
export type Session = { id: string; mandate: Mandate | null; profile: Profile };

/** A demo buyer in Austin; a real platform would use the signed-in account's saved address. */
const demoProfile = (id: string): Profile => ({
	name: { given_name: "Rohan", surname: "Mehta" },
	// one address per session, so every visitor is a first-time customer for the stores' offers
	email_address: `buyer+${id.slice(0, 10)}@example.com`,
	shipping_address: {
		address_line_1: "100 Congress Ave",
		admin_area_2: "Austin",
		admin_area_1: "TX",
		postal_code: "78701",
		country_code: "US",
	},
});

const toSession = (r: typeof sessions.$inferSelect): Session => ({
	id: r.id,
	mandate: (r.mandate as Mandate | null) ?? null,
	profile: (r.profile as Profile | null) ?? demoProfile(r.id),
});

/** The caller's session from its cookie; `create` makes one (and sets the cookie) if missing. */
export async function currentSession(opts: { create: boolean }): Promise<Session> {
	const jar = await cookies();
	const id = jar.get(SESSION_COOKIE)?.value;
	if (id && /^[A-Za-z0-9_-]{22}$/.test(id)) {
		const [row] = await db().select().from(sessions).where(eq(sessions.id, id));
		if (row) return toSession(row);
	}
	if (!opts.create)
		throw new HttpError(401, { name: "NO_SESSION", message: "Start a session first (GET /api/agent/session)" });
	const fresh = randomBytes(16).toString("base64url");
	const [row] = await db()
		.insert(sessions)
		.values({ id: fresh, profile: demoProfile(fresh) })
		.returning();
	jar.set(SESSION_COOKIE, fresh, {
		httpOnly: true,
		sameSite: "lax",
		secure: process.env.NODE_ENV === "production",
		path: "/",
		maxAge: 60 * 60 * 24 * 7,
	});
	return toSession(row);
}

export async function setMandate(sessionId: string, mandate: Mandate): Promise<void> {
	await db().update(sessions).set({ mandate }).where(eq(sessions.id, sessionId));
}

export type SessionCart = { cartId: string; storeId: string; status: string; cart: PayPalCart };

/** A cart this session opened, with the merchant's latest response. */
export async function sessionCart(sessionId: string, cartId: string): Promise<SessionCart> {
	const [row] = await db()
		.select()
		.from(sessionCarts)
		.where(and(eq(sessionCarts.cartId, cartId), eq(sessionCarts.sessionId, sessionId)));
	if (!row) throw new Error(`Unknown cart ${cartId}; use a cart_id returned by create_cart`);
	return { cartId: row.cartId, storeId: row.storeId, status: row.status, cart: row.lastCart as PayPalCart };
}

/** Remember the merchant's latest answer for a cart (the next PUT is built from it). */
export async function saveSessionCart(
	sessionId: string,
	storeId: string,
	cart: PayPalCart,
	status?: "open" | "completed",
): Promise<void> {
	const values = {
		paypalOrderId: cart.payment_method?.token ?? null,
		lastCart: cart as Record<string, unknown>,
		updatedAt: new Date(),
		...(status && { status }),
	};
	await db()
		.insert(sessionCarts)
		.values({ cartId: cart.id!, sessionId, storeId, ...values })
		.onConflictDoUpdate({ target: sessionCarts.cartId, set: values });
}

export async function storeRef(storeId: string) {
	const [s] = await db().select().from(stores).where(eq(stores.id, storeId));
	if (!s?.enabled) throw new Error(`Unknown store ${storeId}`);
	return s;
}

export const enabledStores = () => db().select().from(stores).where(eq(stores.enabled, true));
