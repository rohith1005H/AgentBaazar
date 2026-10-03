/**
 * The cart engine: a pure function from (cart request, catalog, store policy,
 * coupons, clock) to a spec-conformant PayPalCart plus the exact lines and
 * totals to send to PayPal.
 *
 * It never trusts prices or totals from the caller. Every business problem is
 * reported as a `validation_issue` with the category, `specific_issue` and
 * context shapes from PayPal's Cart API spec and Store Sync use-case examples,
 * plus resolution options that carry a machine-applicable `metadata.apply`
 * patch so an agent can fix the cart without parsing prose.
 *
 * No I/O here: the service layer loads inputs and persists outputs.
 */
import type {
	Address,
	AppliedCoupon,
	CartItem,
	CartRequest,
	CheckoutField,
	CheckoutFieldType,
	PayPalCart,
	ResolutionOption,
	ShippingOption,
	ValidationIssue,
} from "@/src/cart-spec/schema";
import type { MerchantPolicy } from "@/src/db/schema";
import { formatAddress, isPoBox, stateOf, validateUsAddress } from "./address";
import { costImpact, percentOf, taxOf, toCents, toMoney, usd } from "./money";
import {
	ACCEPT_BACK_ORDER,
	ACCEPT_PRE_ORDER,
	type CartPatch,
	type CatalogVariant,
	type CouponRow,
	type OrderLine,
	type OrderTotals,
	type ShipTo,
} from "./types";

export type EvaluateInput = {
	request: CartRequest;
	/** Requested variants plus every sibling variant of their products (for alternatives) */
	catalog: ReadonlyMap<string, CatalogVariant>;
	policy: MerchantPolicy;
	/** Coupons referenced by the request, keyed by upper-cased code */
	coupons: ReadonlyMap<string, CouponRow>;
	cartId: string;
	now: Date;
};

export type Evaluation = {
	/** Everything except `id` and `payment_method`, which the service owns */
	cart: Omit<PayPalCart, "id" | "payment_method">;
	/** Purchasable lines, in request order */
	lines: OrderLine[];
	totals: OrderTotals;
	shipTo?: ShipTo;
	/** True when the cart can go to PayPal approval and checkout */
	valid: boolean;
};

type Line = {
	id: string;
	req: CartItem;
	quantity: number;
	variant?: CatalogVariant;
	unitCents?: number;
	purchasable: boolean;
};

export function evaluateCart(input: EvaluateInput): Evaluation {
	const { request, catalog, policy } = input;
	const issues: ValidationIssue[] = [];

	if (policy.maintenance) issues.push(storeClosed());

	// ---- 1. items --------------------------------------------------------
	const lines = mergeItems(request.items, issues).map((l) => priceLine(l, catalog, issues));
	const purchasable = lines.filter((l) => l.purchasable);
	const subtotal = purchasable.reduce((s, l) => s + (l.unitCents ?? 0) * l.quantity, 0);

	// ---- 2. shipping address ---------------------------------------------
	const address = request.shipping_address;
	const shippable = address ? checkAddress(address, policy, purchasable, issues) : missingAddress(issues);
	const state = address ? stateOf(address) : "";

	// ---- 3. checkout fields ----------------------------------------------
	const checkoutFields = evaluateCheckoutFields(lines, request.checkout_fields ?? [], issues);

	// ---- 4. shipping options ---------------------------------------------
	const weightG = purchasable.reduce((s, l) => s + (l.variant?.weightG ?? 0) * l.quantity, 0);
	const shippingOptions = shippable ? shippingOptionsFor(policy, state, weightG, input.now, request) : [];
	const selected = shippingOptions.find((o) => o.is_selected);
	const shipping = selected ? toCents(selected.price.value) : 0;

	// ---- 5. coupons, discounts, tax ----------------------------------------
	const { applied, discount, freeShipping } = applyCoupons(input, subtotal, issues);
	const discountedSubtotal = subtotal - discount;
	const shippingDiscount =
		freeShipping ||
		(policy.coupons.freeShippingOverCents !== undefined && discountedSubtotal >= policy.coupons.freeShippingOverCents)
			? shipping
			: 0;
	const rate = shippable ? (policy.taxRates[state] ?? policy.taxRates["*"] ?? 0) : 0;
	const tax = taxOf(discountedSubtotal, rate);
	const total = discountedSubtotal + shipping - shippingDiscount + tax;

	// ---- 6. status ---------------------------------------------------------
	const validation_status =
		issues.length === 0
			? "VALID"
			: issues.every((i) => i.type === "MISSING_FIELD")
				? "REQUIRES_ADDITIONAL_INFORMATION"
				: "INVALID";
	const valid = validation_status === "VALID" && purchasable.length > 0 && total > 0;

	const totals: OrderTotals = {
		itemTotalCents: subtotal,
		discountCents: discount,
		shippingCents: shipping,
		shippingDiscountCents: shippingDiscount,
		taxCents: tax,
		totalCents: total,
	};

	return {
		cart: {
			status: valid ? "CREATED" : "INCOMPLETE",
			validation_status,
			validation_issues: issues,
			items: lines.map(itemOut),
			customer: request.customer,
			shipping_address: address,
			billing_address: request.billing_address,
			geo_coordinates: request.geo_coordinates,
			available_shipping_options: shippingOptions,
			applied_coupons: applied,
			checkout_fields: checkoutFields,
			totals: {
				subtotal: toMoney(subtotal),
				...(discount > 0 && { discount: toMoney(discount) }),
				shipping: toMoney(shipping),
				...(shippingDiscount > 0 && { shipping_discount: toMoney(shippingDiscount) }),
				tax: toMoney(tax),
				total: toMoney(total),
			},
		},
		lines: purchasable.map((l) => ({
			sku: l.id,
			name: l.variant?.title ?? l.id,
			quantity: l.quantity,
			unitCents: l.unitCents ?? 0,
			url: l.variant?.url ?? undefined,
		})),
		totals,
		shipTo: address && shippable ? shipToOf(address, request) : undefined,
		valid,
	};
}

// ---------------------------------------------------------------- items

/** One line per variant id; duplicate lines are merged by summing quantities. */
function mergeItems(items: CartItem[], issues: ValidationIssue[]): Line[] {
	const byId = new Map<string, Line>();
	items.forEach((req, i) => {
		const id = req.variant_id ?? req.item_id;
		if (!id) {
			issues.push({
				code: "DATA_ERROR",
				type: "MISSING_FIELD",
				message: `items[${i}] has no variant_id`,
				user_message: "One of the items is missing a product identifier.",
				field: `items[${i}].variant_id`,
				context: { specific_issue: "REQUIRED_FIELD_MISSING", field_name: `items[${i}].variant_id` },
				resolution_options: [option("PROVIDE_MISSING_FIELD", "Specify which product variant to buy", "HIGH")],
			});
			return;
		}
		const existing = byId.get(id);
		if (existing) existing.quantity += req.quantity;
		else byId.set(id, { id, req, quantity: req.quantity, purchasable: false });
	});
	return [...byId.values()];
}

function priceLine(line: Line, catalog: ReadonlyMap<string, CatalogVariant>, issues: ValidationIssue[]): Line {
	const v = catalog.get(line.id);
	if (!v) {
		issues.push({
			code: "DATA_ERROR",
			type: "INVALID_DATA",
			message: `Unknown variant ${line.id}`,
			user_message: "This store does not sell one of the requested items.",
			variant_id: line.id,
			context: { specific_issue: "ITEM_NOT_FOUND", field_name: "variant_id", provided_value: line.id },
			resolution_options: [
				option("REMOVE_ITEM", "Remove from cart", "HIGH", { op: "remove_item", variant_id: line.id }),
			],
		});
		return line;
	}
	const priced: Line = { ...line, variant: v, unitCents: v.salePriceCents ?? v.priceCents };
	if (!v.agentCheckout) {
		// The merchant's feed says agents may show this item but not buy it.
		issues.push({
			code: "BUSINESS_RULE_ERROR",
			type: "BUSINESS_RULE",
			message: `${line.id} is not eligible for agent checkout`,
			user_message: `${v.title} can only be bought on the store's own site.`,
			variant_id: line.id,
			context: { restricted_items: [line.id] },
			resolution_options: [
				{ ...option("REDIRECT_TO_MERCHANT", "Buy on the store's site", "HIGH"), ...(v.url && { url: v.url }) },
				option("REMOVE_ITEM", "Remove from cart", "LOW", { op: "remove_item", variant_id: line.id }),
			],
		});
		return priced;
	}
	checkPrice(priced, issues);
	// A price change still blocks checkout (it is an issue) but the line stays in
	// the totals at the current price, so the buyer sees what they would pay.
	priced.purchasable = checkStock(priced, catalog, issues);
	return priced;
}

/** A caller that quotes a price we no longer charge must accept the new one explicitly. */
function checkPrice(line: Line, issues: ValidationIssue[]) {
	const quoted = line.req.price;
	const v = line.variant!;
	const current = line.unitCents!;
	if (!quoted) return;
	if (quoted.currency_code !== v.currency) {
		issues.push({
			code: "PRICING_ERROR",
			type: "INVALID_DATA",
			message: `Currency ${quoted.currency_code} not supported`,
			user_message: `This store only accepts ${v.currency}.`,
			variant_id: line.id,
			context: {
				specific_issue: "CURRENCY_NOT_SUPPORTED",
				supported_currencies: [v.currency],
				found_currencies: [quoted.currency_code],
			},
			resolution_options: [
				option("USE_DIFFERENT_CURRENCY", `Pay in ${v.currency}`, "HIGH", {
					op: "set_price",
					variant_id: line.id,
					price: toMoney(current, v.currency),
				}),
			],
		});
		return;
	}
	const quotedCents = toCents(quoted.value);
	if (quotedCents === current) return;
	const delta = current - quotedCents;
	issues.push({
		code: "PRICING_ERROR",
		type: "BUSINESS_RULE",
		message: "Product price has changed since cart creation",
		user_message: `The price for ${v.title} has ${delta > 0 ? "increased" : "dropped"} from ${usd(quotedCents)} to ${usd(current)}. Continue with the new price?`,
		variant_id: line.id,
		context: {
			specific_issue: "PRICE_MISMATCH",
			original_price: quoted.value,
			current_price: toMoney(current).value,
			currency_code: v.currency,
			...(delta > 0 ? { price_increase: toMoney(delta).value } : { price_decrease: toMoney(-delta).value }),
		},
		resolution_options: [
			option(
				"ACCEPT_NEW_PRICE",
				`Continue with ${usd(current)}`,
				"HIGH",
				{ op: "set_price", variant_id: line.id, price: toMoney(current) },
				{ cost_impact: costImpact(delta * line.quantity), auto_applicable: delta < 0 },
			),
			option(
				"REMOVE_ITEM",
				"Remove from cart",
				"MEDIUM",
				{ op: "remove_item", variant_id: line.id },
				{ cost_impact: costImpact(-quotedCents * line.quantity) },
			),
		],
	});
}

const inStock = (v: CatalogVariant) => v.availability === "in_stock" && v.stockQty > 0;
const accepted = (req: CartItem, name: string) =>
	req.custom_options?.some((o) => o.name === name && o.value === "true") ?? false;

/** Returns true when the line can be fulfilled as requested. */
function checkStock(line: Line, catalog: ReadonlyMap<string, CatalogVariant>, issues: ValidationIssue[]): boolean {
	const v = line.variant!;
	const lineCents = (line.unitCents ?? 0) * line.quantity;
	const remove = option(
		"REMOVE_ITEM",
		"Remove from cart",
		"LOW",
		{ op: "remove_item", variant_id: line.id },
		{ cost_impact: costImpact(-lineCents) },
	);

	if (v.availability === "backorder" || v.availability === "preorder") {
		const back = v.availability === "backorder";
		const flag = back ? ACCEPT_BACK_ORDER : ACCEPT_PRE_ORDER;
		if (accepted(line.req, flag)) return true;
		const when = v.restockEta ? ` (ships ${v.restockEta})` : "";
		issues.push({
			code: "INVENTORY_ISSUE",
			type: "BUSINESS_RULE",
			message: back ? "Item is currently back-ordered" : "Item is available for pre-order only",
			user_message: `${v.title} ${back ? "is back-ordered" : "is a pre-order"}${when}. Would you like to proceed?`,
			variant_id: line.id,
			context: {
				specific_issue: back ? "BACK_ORDERED" : "PRE_ORDER_ONLY",
				available_quantity: 0,
				requested_quantity: line.quantity,
				...(v.restockEta && { estimated_ship_date: isoDate(v.restockEta) }),
			},
			resolution_options: [
				option(
					back ? "ACCEPT_BACK_ORDER" : "ACCEPT_PRE_ORDER",
					`Order anyway${when}`,
					"HIGH",
					{ op: "add_custom_option", variant_id: line.id, option: { name: flag, value: "true" } },
					{ cost_impact: "$0.00" },
				),
				...alternativeOptions(v, line.quantity, catalog),
				remove,
			],
		});
		return false;
	}

	if (inStock(v) && v.stockQty >= line.quantity) return true;

	const alternatives = alternativesFor(v, line.quantity, catalog);
	if (inStock(v)) {
		// some, but not enough
		issues.push({
			code: "INVENTORY_ISSUE",
			type: "BUSINESS_RULE",
			message: `Only ${v.stockQty} available, ${line.quantity} requested`,
			user_message: `Only ${v.stockQty} of ${v.title} left. Reduce the quantity?`,
			variant_id: line.id,
			context: {
				specific_issue: "INSUFFICIENT_INVENTORY",
				available_quantity: v.stockQty,
				requested_quantity: line.quantity,
				...(alternatives.length > 0 && { suggested_alternatives: alternatives.map((a) => a.id) }),
			},
			resolution_options: [
				option(
					"MODIFY_CART",
					`Buy ${v.stockQty} instead`,
					"HIGH",
					{ op: "set_quantity", variant_id: line.id, quantity: v.stockQty },
					{ auto_applicable: true, max_quantity: v.stockQty },
				),
				...alternativeOptions(v, line.quantity, catalog),
				remove,
			],
		});
		return false;
	}

	issues.push({
		code: "INVENTORY_ISSUE",
		type: "BUSINESS_RULE",
		message: "Product is no longer available",
		user_message:
			alternatives.length > 0
				? `${v.title} is out of stock. ${alternatives[0].title} is available${sameUnit(alternatives[0], v) ? " at the same price" : ""}.`
				: `${v.title} is out of stock.`,
		variant_id: line.id,
		context: {
			specific_issue: "ITEM_OUT_OF_STOCK",
			available_quantity: 0,
			requested_quantity: line.quantity,
			...(alternatives.length > 0 && { suggested_alternatives: alternatives.map((a) => a.id) }),
			...(v.restockEta && { restock_date: isoDate(v.restockEta) }),
		},
		resolution_options: [
			...alternativeOptions(v, line.quantity, catalog),
			...(v.restockEta
				? [
						option("WAIT_FOR_RESTOCK", `Wait for restock (${v.restockEta})`, "MEDIUM", undefined, {
							restock_date: v.restockEta,
						}),
					]
				: []),
			remove,
		],
	});
	return false;
}

/** In-stock siblings of the same product: same size first, then same price. At most three. */
function alternativesFor(
	v: CatalogVariant,
	qty: number,
	catalog: ReadonlyMap<string, CatalogVariant>,
): CatalogVariant[] {
	const score = (a: CatalogVariant) => (a.size === v.size ? 2 : 0) + (sameUnit(a, v) ? 1 : 0);
	return [...catalog.values()]
		.filter((a) => a.productId === v.productId && a.id !== v.id && inStock(a) && a.stockQty >= qty)
		.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id))
		.slice(0, 3);
}

function alternativeOptions(v: CatalogVariant, qty: number, catalog: ReadonlyMap<string, CatalogVariant>) {
	return alternativesFor(v, qty, catalog).map((a, i) =>
		option(
			"CHOOSE_DIFFERENT_VARIANT",
			`Switch to ${a.title}${sameUnit(a, v) ? "" : ` (${usd(unitOf(a))})`}`,
			i === 0 ? "HIGH" : "MEDIUM",
			{ op: "replace_variant", variant_id: v.id, with_variant_id: a.id },
			{
				// safe to apply without asking only when it costs the buyer nothing more
				auto_applicable: i === 0 && unitOf(a) <= unitOf(v) && a.size === v.size,
				cost_impact: costImpact((unitOf(a) - unitOf(v)) * qty),
				alternative: { variant_id: a.id, name: a.title, price: toMoney(unitOf(a)), color: a.color, size: a.size },
			},
		),
	);
}

const unitOf = (v: CatalogVariant) => v.salePriceCents ?? v.priceCents;
const sameUnit = (a: CatalogVariant, b: CatalogVariant) => unitOf(a) === unitOf(b);

function itemOut(l: Line): CartItem {
	const v = l.variant;
	const attrs = [
		...(v?.color ? [{ name: "Color", value: v.color }] : []),
		...(v?.size ? [{ name: "Size", value: v.size }] : []),
	];
	return {
		variant_id: l.id,
		...(v?.groupId && { parent_id: v.groupId }),
		quantity: l.quantity,
		name: v?.title ?? l.req.name,
		...(v?.description && { description: v.description.slice(0, 240) }),
		...(v?.url && { item_url: v.url }),
		...(l.unitCents !== undefined && { price: toMoney(l.unitCents, v?.currency) }),
		...(attrs.length > 0 && { selected_attributes: attrs }),
		...(l.req.gift_options && { gift_options: l.req.gift_options }),
		...(l.req.custom_options && { custom_options: l.req.custom_options }),
	};
}

// ---------------------------------------------------------------- address

function missingAddress(issues: ValidationIssue[]): false {
	issues.push({
		code: "SHIPPING_ERROR",
		type: "MISSING_FIELD",
		message: "Shipping address is required",
		user_message: "Where should this order be delivered?",
		field: "shipping_address",
		context: { specific_issue: "MISSING_SHIPPING_ADDRESS" },
		resolution_options: [option("PROVIDE_MISSING_FIELD", "Add a shipping address", "HIGH")],
	});
	return false;
}

/** Returns true when we can ship purchasable items to this address. */
function checkAddress(a: Address, policy: MerchantPolicy, lines: Line[], issues: ValidationIssue[]): boolean {
	if (a.country_code.toUpperCase() !== "US") {
		issues.push({
			code: "SHIPPING_ERROR",
			type: "BUSINESS_RULE",
			message: "Store does not ship outside the US",
			user_message: "Sorry, this store only ships within the United States.",
			field: "shipping_address.country_code",
			context: {
				specific_issue: "INTERNATIONAL_SHIPPING_RESTRICTED",
				destination_country: a.country_code,
				supported_countries: ["US"],
			},
			resolution_options: [
				option("UPDATE_ADDRESS", "Ship to a US address", "HIGH"),
				option("CONTACT_SUPPORT", "Contact the store", "LOW"),
			],
		});
		return false;
	}

	const failures = validateUsAddress(a);
	if (failures.length > 0) {
		issues.push({
			code: "SHIPPING_ERROR",
			type: "INVALID_DATA",
			message: "Shipping address validation failed",
			user_message: "The shipping address looks incomplete or invalid. Please check it.",
			field: "shipping_address",
			context: {
				specific_issue: "SHIPPING_ADDRESS_INVALID",
				validation_failures: failures,
				provided_address: formatAddress(a),
			},
			resolution_options: [
				option("UPDATE_ADDRESS", "Correct the address", "HIGH"),
				option("PROVIDE_MISSING_FIELD", "Add the missing parts", "MEDIUM"),
			],
		});
		return false;
	}

	const state = stateOf(a);
	if (!policy.regionsServed.includes("*") && !policy.regionsServed.includes(state)) {
		issues.push({
			code: "SHIPPING_ERROR",
			type: "BUSINESS_RULE",
			message: `No shipping to ${state}`,
			user_message: `Sorry, this store doesn't deliver to ${state}.`,
			field: "shipping_address.admin_area_1",
			context: { specific_issue: "SHIPPING_ZONE_NOT_COVERED", restricted_region: state, destination_country: "US" },
			resolution_options: [
				option("UPDATE_ADDRESS", "Ship somewhere else", "HIGH"),
				option("CONTACT_SUPPORT", "Contact the store", "LOW"),
			],
		});
		return false;
	}

	const fragile = lines.filter((l) => l.variant?.fragile);
	if (fragile.length > 0 && !policy.poBoxAllowedForFragile && isPoBox(a)) {
		issues.push({
			code: "SHIPPING_ERROR",
			type: "BUSINESS_RULE",
			message: "PO box delivery not available for this order",
			user_message: "Fragile items need a street address and can't be delivered to a PO box.",
			field: "shipping_address",
			context: {
				specific_issue: "SHIPPING_TO_PO_BOX_NOT_ALLOWED",
				restricted_items: fragile.map((l) => l.id),
				restriction_reason: "fragile_item",
				po_box_detected: true,
			},
			resolution_options: [
				option("UPDATE_ADDRESS", "Use a street address instead", "HIGH"),
				...fragile.map((l) =>
					option(
						"REMOVE_ITEM",
						`Remove ${l.variant?.title}`,
						"LOW",
						{ op: "remove_item", variant_id: l.id },
						{ cost_impact: costImpact(-(l.unitCents ?? 0) * l.quantity) },
					),
				),
			],
		});
		return false;
	}
	return true;
}

function shipToOf(a: Address, req: CartRequest): ShipTo {
	const n = req.customer?.name;
	const fullName = [n?.given_name, n?.surname].filter(Boolean).join(" ") || undefined;
	return {
		fullName,
		addressLine1: a.address_line_1,
		addressLine2: a.address_line_2,
		city: a.admin_area_2,
		state: stateOf(a),
		postalCode: a.postal_code,
		countryCode: a.country_code.toUpperCase(),
	};
}

// ---------------------------------------------------------------- shipping

function shippingOptionsFor(
	policy: MerchantPolicy,
	state: string,
	weightG: number,
	now: Date,
	req: CartRequest,
): ShippingOption[] {
	const kg = Math.ceil(weightG / 1000);
	const options = policy.shippingOptions
		.filter((o) => o.regions.includes("*") || o.regions.includes(state))
		.map((o) => ({
			id: o.id,
			name: o.name,
			price: toMoney(o.baseCents + o.perKgCents * kg),
			estimated_delivery: addDays(now, o.etaDays),
			is_selected: false,
		}));
	if (options.length === 0) return options;
	// keep the caller's selection when it is still offered, else the cheapest
	const wanted = req.available_shipping_options?.find((o) => o.is_selected)?.id;
	const pick =
		options.find((o) => o.id === wanted) ??
		options.reduce((a, b) => (toCents(b.price.value) < toCents(a.price.value) ? b : a));
	pick.is_selected = true;
	return options;
}

// ---------------------------------------------------------------- checkout fields

const VALUE_SCHEMAS: Partial<Record<CheckoutFieldType, Record<string, string>>> = {
	ALLERGY_INFORMATION: { type: "ALLERGY_INFORMATION", allergies: "string[] (empty array for none)" },
	GIFT_MESSAGE: { type: "GIFT_MESSAGE", message: "string, max 500" },
	DELIVERY_INSTRUCTIONS: { type: "DELIVERY_INSTRUCTIONS", instructions: "string, max 200" },
	TERMS_ACCEPTANCE: { type: "TERMS_ACCEPTANCE", accepted: "true", terms_version: "string" },
	AGE_VERIFICATION_18_PLUS: { type: "AGE_VERIFICATION_18_PLUS", confirmed: "true" },
	AGE_VERIFICATION_21_PLUS: { type: "AGE_VERIFICATION_21_PLUS", confirmed: "true" },
};

/** Validates a field value against the shape PayPal's spec defines for its type. */
export function checkoutValueValid(type: CheckoutFieldType, value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.type !== type) return false;
	const str = (x: unknown, max: number) => typeof x === "string" && x.trim().length > 0 && x.length <= max;
	switch (type) {
		case "AGE_VERIFICATION_18_PLUS":
		case "AGE_VERIFICATION_21_PLUS":
			return v.confirmed === true;
		case "GIFT_RECIPIENT_EMAIL":
			return typeof v.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email);
		case "GIFT_RECIPIENT_NAME":
			return str(v.name, 140);
		case "GIFT_MESSAGE":
			return str(v.message, 500);
		case "DELIVERY_INSTRUCTIONS":
			return str(v.instructions, 200);
		case "ALLERGY_INFORMATION":
			return Array.isArray(v.allergies) && v.allergies.every((a) => typeof a === "string");
		case "CUSTOM_ENGRAVING_TEXT":
			return str(v.text, 100);
		case "TERMS_ACCEPTANCE":
			return v.accepted === true && typeof v.terms_version === "string";
		case "PRIVACY_CONSENT":
			return v.consented === true;
		default:
			return true;
	}
}

function evaluateCheckoutFields(lines: Line[], provided: CheckoutField[], issues: ValidationIssue[]): CheckoutField[] {
	const requiredBy = new Map<CheckoutFieldType, string[]>();
	for (const l of lines) {
		for (const t of l.variant?.requiresFields ?? []) requiredBy.set(t, [...(requiredBy.get(t) ?? []), l.id]);
	}
	const byType = new Map(provided.map((f) => [f.type, f]));
	const out: CheckoutField[] = [];

	for (const [type, variantIds] of requiredBy) {
		const given = byType.get(type);
		if (given?.value !== undefined && checkoutValueValid(type, given.value)) {
			out.push({ type, status: "COMPLETED", value: given.value, context: { required_by: variantIds } });
			continue;
		}
		const rejected = given?.value !== undefined;
		const issue: ValidationIssue = {
			code: "DATA_ERROR",
			type: rejected ? "INVALID_DATA" : "MISSING_FIELD",
			message: rejected ? `Checkout field ${type} has an invalid value` : `Checkout field ${type} is required`,
			user_message: FIELD_PROMPTS[type] ?? `Please provide ${type.toLowerCase().replaceAll("_", " ")}.`,
			field: `checkout_fields.${type}`,
			context: {
				specific_issue: rejected ? "INVALID_ITEM_DATA" : "MISSING_CHECKOUT_FIELDS",
				required_fields: [type],
				field_name: type,
			},
			resolution_options: [
				option("PROVIDE_MISSING_FIELD", FIELD_PROMPTS[type] ?? `Provide ${type}`, "HIGH", {
					op: "set_checkout_field",
					type,
					value_schema: VALUE_SCHEMAS[type] ?? { type },
				}),
			],
		};
		issues.push(issue);
		out.push({
			type,
			status: rejected ? "REJECTED" : "PENDING",
			...(rejected && { value: given?.value }),
			context: { required_by: variantIds },
			validation_issue: issue,
		});
	}
	// optional fields the caller supplied are kept (e.g. delivery instructions)
	for (const f of provided) {
		if (!requiredBy.has(f.type) && checkoutValueValid(f.type, f.value)) out.push({ ...f, status: "COMPLETED" });
	}
	return out;
}

const FIELD_PROMPTS: Partial<Record<CheckoutFieldType, string>> = {
	ALLERGY_INFORMATION: "Any allergies we should know about? (an empty list is fine)",
	GIFT_MESSAGE: "What should the gift message say?",
	AGE_VERIFICATION_21_PLUS: "Please confirm the recipient is 21 or older.",
	AGE_VERIFICATION_18_PLUS: "Please confirm the recipient is 18 or older.",
	TERMS_ACCEPTANCE: "Please accept the store's terms.",
};

// ---------------------------------------------------------------- coupons

function applyCoupons(input: EvaluateInput, subtotal: number, issues: ValidationIssue[]) {
	const requested = input.request.coupons ?? [];
	const removed = new Set(requested.filter((c) => c.action === "REMOVE").map((c) => c.code.toUpperCase()));
	const codes = [...new Set(requested.filter((c) => c.action === "APPLY").map((c) => c.code.toUpperCase()))].filter(
		(c) => !removed.has(c),
	);

	const cap = Math.min(subtotal, percentOf(subtotal, input.policy.coupons.maxTotalPct));
	const applied: AppliedCoupon[] = [];
	let discount = 0;
	let freeShipping = false;

	for (const code of codes) {
		const row = input.coupons.get(code);
		const problem = couponProblem(row, code, subtotal, input);
		if (problem) {
			issues.push(problem);
			continue;
		}
		const c = row!;
		if (c.kind === "free_shipping") {
			freeShipping = true;
			applied.push({ code, description: c.description ?? "Free shipping" });
			continue;
		}
		const raw = c.kind === "percent" ? percentOf(subtotal, c.value) : c.value;
		const amount = Math.max(0, Math.min(raw, cap - discount));
		discount += amount;
		applied.push({ code, description: c.description ?? undefined, discount_amount: toMoney(amount) });
	}
	return { applied, discount, freeShipping };
}

function couponProblem(
	row: CouponRow | undefined,
	code: string,
	subtotal: number,
	input: EvaluateInput,
): ValidationIssue | undefined {
	const base = (specific: string | undefined, message: string, user: string, extra: Record<string, unknown> = {}) =>
		({
			code: "PRICING_ERROR",
			type: specific ? "BUSINESS_RULE" : "INVALID_DATA",
			message,
			user_message: user,
			field: "coupons",
			context: { ...(specific && { specific_issue: specific }), coupon_code: code, ...extra },
			resolution_options: [
				option("REMOVE_COUPON", `Remove ${code}`, "HIGH", { op: "remove_coupon", code }, { auto_applicable: true }),
				option("APPLY_DIFFERENT_COUPON", "Try a different code", "LOW"),
			],
		}) satisfies ValidationIssue;

	if (!row) return base(undefined, `Unknown coupon ${code}`, `The code ${code} isn't valid here.`);
	if (row.expiresAt && row.expiresAt <= input.now)
		return base("DISCOUNT_EXPIRED", `Coupon ${code} expired`, `The code ${code} has expired.`, {
			expiration_date: row.expiresAt.toISOString(),
			current_date: input.now.toISOString(),
		});
	if (row.used >= row.maxUses)
		return base(
			"DISCOUNT_USAGE_LIMIT_EXCEEDED",
			`Coupon ${code} fully used`,
			`The code ${code} has already been used.`,
			{
				usage_limit: row.maxUses,
				current_usage: row.used,
			},
		);
	if (row.issuedToCartId && row.issuedToCartId !== input.cartId)
		return base(
			"DISCOUNT_CUSTOMER_INELIGIBLE",
			`Coupon ${code} belongs to another cart`,
			`The code ${code} can't be used on this order.`,
		);
	if (subtotal < row.minSubtotalCents)
		return base(
			"DISCOUNT_MINIMUM_NOT_MET",
			`Subtotal below ${row.minSubtotalCents}`,
			`The code ${code} needs an order of at least ${usd(row.minSubtotalCents)}.`,
			{ minimum_order_amount: toMoney(row.minSubtotalCents).value },
		);
	return undefined;
}

// ---------------------------------------------------------------- misc

function storeClosed(): ValidationIssue {
	return {
		code: "BUSINESS_RULE_ERROR",
		type: "BUSINESS_RULE",
		message: "Store is currently in maintenance mode",
		user_message: "The store is temporarily closed for maintenance. Please try again later.",
		context: { specific_issue: "STORE_TEMPORARILY_CLOSED", service_status: "maintenance", retry_after: 600 },
		resolution_options: [
			option("RETRY_LATER", "Try again in 10 minutes", "HIGH", undefined, {
				auto_applicable: true,
				estimated_time: "10 minutes",
			}),
		],
	};
}

function option(
	action: ResolutionOption["action"],
	label: string,
	priority: "HIGH" | "MEDIUM" | "LOW",
	apply?: CartPatch,
	extra: Record<string, unknown> = {},
): ResolutionOption {
	return { action, label, metadata: { priority, ...extra, ...(apply && { apply }) } };
}

function addDays(d: Date, days: number): string {
	const x = new Date(d.getTime() + days * 86_400_000);
	return x.toISOString().slice(0, 10);
}

/** "2026-10-20" -> "2026-10-20T00:00:00Z"; full timestamps pass through. */
const isoDate = (d: string) => (d.length === 10 ? `${d}T00:00:00Z` : d);
