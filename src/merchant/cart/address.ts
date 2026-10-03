/**
 * US shipping address checks. Store Sync is US-only, so we validate exactly
 * what we need to price shipping and tax: street, city, state, ZIP.
 */
import type { Address } from "@/src/cart-spec/schema";

export const US_STATES = new Set(
	"AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR".split(
		" ",
	),
);

export type AddressFailure =
	| "missing_street"
	| "missing_city"
	| "missing_state"
	| "invalid_state"
	| "missing_postal_code"
	| "invalid_postal_code";

/** Returns the list of problems with a US address; empty means usable. */
export function validateUsAddress(a: Address): AddressFailure[] {
	const failures: AddressFailure[] = [];
	if (!a.address_line_1?.trim()) failures.push("missing_street");
	if (!a.admin_area_2?.trim()) failures.push("missing_city");
	const state = a.admin_area_1?.trim().toUpperCase();
	if (!state) failures.push("missing_state");
	else if (!US_STATES.has(state)) failures.push("invalid_state");
	const zip = a.postal_code?.trim();
	if (!zip) failures.push("missing_postal_code");
	else if (!/^\d{5}(-\d{4})?$/.test(zip)) failures.push("invalid_postal_code");
	return failures;
}

/** "PO Box 12", "P.O. Box", "Post Office Box", "POB 12" — on either address line. */
export function isPoBox(a: Address): boolean {
	const re = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|pob\s+\d+)\b/i;
	return re.test(a.address_line_1 ?? "") || re.test(a.address_line_2 ?? "");
}

export const stateOf = (a: Address) => a.admin_area_1?.trim().toUpperCase() ?? "";

export function formatAddress(a: Address): string {
	return [a.address_line_1, a.address_line_2, a.admin_area_2, a.admin_area_1, a.postal_code, a.country_code]
		.filter(Boolean)
		.join(", ");
}
