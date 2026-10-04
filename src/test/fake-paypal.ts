/**
 * In-memory stand-in for src/merchant/paypal/orders.ts with the PayPal semantics
 * the cart service relies on: approval, PATCH, idempotent request ids, authorize /
 * capture results with their own status and amount, void, refund. Tests steer
 * failures through `fake.next`.
 */

import { PayPalError } from "@/src/merchant/paypal/http";
import type { CreatedOrder, CreateOrderInput } from "@/src/merchant/paypal/orders";

type FakeOrder = {
	id: string;
	status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "COMPLETED";
	amountCents: number;
	payerId?: string;
	authorizationId?: string;
	captureId?: string;
	/** what the authorization/capture was for, when a test makes it differ from the order */
	chargedCents?: number;
};

type ChargeBehaviour =
	| { kind: "decline"; issue: string }
	| { kind: "status"; status: string }
	| { kind: "amount"; amountCents: number }
	/** PayPal performs the charge but the response is lost (timeout) */
	| { kind: "lost-response" }
	/** Run something (e.g. a concurrent cart update) while PayPal is processing */
	| { kind: "during"; fn: () => Promise<void> };

/** PayPal's ids are globally unique; so are these (rows from other tests share the database). */
const RUN = Date.now().toString(36).toUpperCase();
let nextId = 0;

const money = (cents: number) => ({ currencyCode: "USD", value: (cents / 100).toFixed(2) });

export const fake = {
	orders: new Map<string, FakeOrder>(),
	byRequestId: new Map<string, unknown>(),
	voided: [] as string[],
	/** amountCents as requested (undefined = the rest); cents = what was refunded */
	refunded: [] as { captureId: string; amountCents?: number; cents: number }[],
	charges: 0,
	next: {
		charge: undefined as ChargeBehaviour | undefined,
		getOrder: undefined as (() => Promise<void>) | undefined,
		/** make the next void fail, as PayPal being down would */
		voidFails: false,
	},
	seq: 0,
	reset() {
		this.orders.clear();
		this.byRequestId.clear();
		this.voided = [];
		this.refunded = [];
		this.charges = 0;
		this.next = { charge: undefined, getOrder: undefined, voidFails: false };
	},
	/** The authorization PayPal made on an order */
	authorizationOf(id: string) {
		return this.orders.get(id)?.authorizationId;
	},
	approve(id: string, payerId = "PAYER-TEST") {
		const o = this.orders.get(id)!;
		o.status = "APPROVED";
		o.payerId = payerId;
	},
};

function idempotent<T>(requestId: string, run: () => T): T {
	if (fake.byRequestId.has(requestId)) return fake.byRequestId.get(requestId) as T;
	const out = run();
	fake.byRequestId.set(requestId, out);
	return out;
}

export async function createOrder(_c: unknown, input: CreateOrderInput): Promise<CreatedOrder> {
	return idempotent(input.requestId, () => {
		const id = `PP${String(++fake.seq).padStart(15, "0")}`;
		fake.orders.set(id, { id, status: "PAYER_ACTION_REQUIRED", amountCents: input.totals.totalCents });
		return {
			id,
			status: "PAYER_ACTION_REQUIRED",
			approvalUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`,
		};
	});
}

export async function getOrder(_c: unknown, id: string) {
	const hook = fake.next.getOrder;
	fake.next.getOrder = undefined;
	if (hook) await hook();
	const o = fake.orders.get(id);
	if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "order not found");
	return {
		id,
		status: o.status,
		payer: o.payerId ? { payerId: o.payerId } : undefined,
		purchaseUnits: [
			{
				amount: money(o.amountCents),
				payments: {
					authorizations: o.authorizationId
						? [{ id: o.authorizationId, status: "CREATED", amount: money(o.chargedCents ?? o.amountCents) }]
						: [],
					captures: o.captureId
						? [{ id: o.captureId, status: "COMPLETED", amount: money(o.chargedCents ?? o.amountCents) }]
						: [],
				},
			},
		],
	};
}

export async function patchOrder(_c: unknown, id: string, patch: { totals: { totalCents: number } }) {
	const o = fake.orders.get(id)!;
	if (o.status === "COMPLETED")
		throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "order completed", undefined, [{ issue: "ORDER_COMPLETED" }]);
	o.amountCents = patch.totals.totalCents;
}

async function charge(id: string, requestId: string, kind: "authorization" | "capture") {
	const behaviour = fake.next.charge;
	fake.next.charge = undefined;
	if (behaviour?.kind === "during") await behaviour.fn();
	if (fake.byRequestId.has(requestId)) return fake.byRequestId.get(requestId);

	const o = fake.orders.get(id)!;
	if (behaviour?.kind === "decline")
		throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "declined", "dbg-1", [{ issue: behaviour.issue }]);
	if (o.status !== "APPROVED")
		throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "not approved", "dbg-2", [{ issue: "ORDER_NOT_APPROVED" }]);

	fake.charges += 1;
	o.status = "COMPLETED";
	const chargeId = `${kind === "authorization" ? "AUTH" : "CAP"}-${RUN}-${++nextId}`;
	if (kind === "authorization") o.authorizationId = chargeId;
	else o.captureId = chargeId;
	const status = behaviour?.kind === "status" ? behaviour.status : kind === "authorization" ? "CREATED" : "COMPLETED";
	const amountCents = behaviour?.kind === "amount" ? behaviour.amountCents : o.amountCents;
	o.chargedCents = amountCents;
	const result =
		kind === "authorization"
			? { authorizationId: chargeId, status, amountCents }
			: { captureId: chargeId, status, amountCents };
	fake.byRequestId.set(requestId, result);
	if (behaviour?.kind === "lost-response") throw new Error("socket hang up");
	return result;
}

export const authorizeOrder = (_c: unknown, id: string, requestId: string) => charge(id, requestId, "authorization");
export const captureOrder = (_c: unknown, id: string, requestId: string) => charge(id, requestId, "capture");

export async function voidAuthorization(_c: unknown, authorizationId: string) {
	if (fake.next.voidFails) {
		fake.next.voidFails = false;
		throw new PayPalError(503, "SERVICE_UNAVAILABLE", "try later");
	}
	fake.voided.push(authorizationId);
}

export async function refundCapture(
	_c: unknown,
	captureId: string,
	requestId: string,
	opts: { amountCents?: number } = {},
) {
	return idempotent(requestId, () => {
		const o = [...fake.orders.values()].find((x) => x.captureId === captureId);
		const captured = o?.chargedCents ?? o?.amountCents ?? 0;
		const left = captured - fake.refunded.filter((r) => r.captureId === captureId).reduce((n, r) => n + r.cents, 0);
		const cents = opts.amountCents ?? left;
		if (cents <= 0 || cents > left)
			throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "refund exceeds capture", "dbg-4", [
				{ issue: "REFUND_AMOUNT_EXCEEDED" },
			]);
		fake.refunded.push({ captureId, amountCents: opts.amountCents, cents });
		return { refundId: `REF-${RUN}-${++nextId}`, status: "COMPLETED", amountCents: cents };
	});
}

/** Capture on ship. Steered by `fake.next.charge` (decline, status) like the checkout charge. */
export async function captureAuthorization(_c: unknown, authorizationId: string, requestId: string) {
	const behaviour = fake.next.charge;
	fake.next.charge = undefined;
	if (fake.byRequestId.has(requestId)) return fake.byRequestId.get(requestId);
	const o = [...fake.orders.values()].find((x) => x.authorizationId === authorizationId);
	if (!o) throw new PayPalError(404, "RESOURCE_NOT_FOUND", "authorization not found");
	if (behaviour?.kind === "decline")
		throw new PayPalError(422, "UNPROCESSABLE_ENTITY", "declined", "dbg-3", [{ issue: behaviour.issue }]);
	fake.charges += 1;
	o.captureId = `CAP-${authorizationId}`;
	const result = {
		captureId: o.captureId,
		status: behaviour?.kind === "status" ? behaviour.status : "COMPLETED",
		amountCents: o.chargedCents ?? o.amountCents,
	};
	fake.byRequestId.set(requestId, result);
	return result;
}

export async function addTracking() {
	return "TRACKER-1";
}
