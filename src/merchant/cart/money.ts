/**
 * Money is integer cents everywhere inside the merchant side. It becomes a
 * decimal string only at the boundary (Cart API `Money`, PayPal amounts), so
 * every total and breakdown adds up to the cent.
 */
import type { Money } from "@/src/cart-spec/schema";

/** "12.3" -> 1230, "12.34" -> 1234. Rejects anything that is not a plain decimal. */
export function toCents(value: string): number {
	const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
	if (!m) throw new Error(`Not a decimal amount: "${value}"`);
	return Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
}

export function toMoney(cents: number, currency_code = "USD"): Money {
	if (!Number.isInteger(cents) || cents < 0) throw new Error(`Invalid cents: ${cents}`);
	return { currency_code, value: (cents / 100).toFixed(2) };
}

/** "$12.34" for human-readable messages. */
export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** Signed cost impact label used in resolution option metadata, e.g. "-$39.00". */
export const costImpact = (cents: number) => `${cents < 0 ? "-" : "+"}${usd(Math.abs(cents))}`;

/** Half-up rounding of a fractional cent amount. */
export const roundCents = (x: number) => Math.round(x + Number.EPSILON);
