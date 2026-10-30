'use server';

/**
 * Delivery server actions. Run server-side so the customer JWT stays in the
 * httpOnly cookie; the backend derives the customer id from the bearer token.
 *
 * Backend routes (customer-authenticated):
 *   POST /store/delivery-orders            — request batch delivery
 *   GET  /store/delivery-orders            — the caller's orders
 *   POST /store/delivery-orders/:id/address — edit address pre-ship
 *   POST /store/delivery-orders/:id/cancel  — cancel pre-ship (cards → vault)
 *   GET  /store/rewards/withdraw            — today's prize-shipping allowance
 *
 * Those five go through the `Store` port (src/lib/store.ts), which owns the
 * cookie read, the bearer, the schema check and the failure log. The ADDRESS
 * BOOK does not: `sdk.store.customer.createAddress/updateAddress/deleteAddress`
 * are built-in Medusa endpoints with their own typed responses, they take
 * headers positionally, and re-expressing them as raw paths here would trade
 * `HttpTypes.StoreCustomerResponse` for a hand-written schema for nothing. They
 * keep `getAuthToken`, which is why this file still imports it.
 */
import type { HttpTypes } from '@medusajs/types';
import { sdk } from '@/lib/medusa';
import { store, type Failure } from '@/lib/store';
import { logger } from '@/lib/logger';
import {
  getAuthToken,
  getCustomer,
  getCustomerSession,
} from '@/lib/data/customer';
import {
  CancelDeliverySchema,
  DeliveryOrdersPageSchema,
  UncheckedSchema,
  PrizeAllowanceSchema,
  type DeliveryOrderStatus,
} from '@/lib/data/schemas';
import {
  friendlyError,
  friendlyFailure,
  isAuthError,
  TRANSPORT_RULES,
  UNAUTHORIZED,
  type ErrorRule,
} from '@/lib/errors';
import {
  DELIVERY_RULES,
  DELIVERY_FALLBACK,
  DELIVERY_LOGIN,
} from '@/lib/delivery-errors';
import { normalizePhone } from '@/lib/profile-validation';
import {
  isShippableCountry,
  isShippablePostcode,
  postcodeHint,
} from '@/lib/delivery-fee';
import { toCardView, type CardView } from '@/lib/card-view';

export type DeliveryOrderItemView = {
  pullId: string;
  /** The shipped card, or null when the backend no longer resolves it. The
   *  route sends handle/name/image/slab_image only; the other view fields
   *  read as their null defaults. */
  card: CardView | null;
};
export type DeliveryOrderView = {
  id: string;
  // Derived from DeliveryOrderSchema so this can't drift from what actually
  // parses. Currently the transitional old ∪ new union (deploy skew) — every
  // consumer that switches on it must stay exhaustive over the widened set.
  status: DeliveryOrderStatus;
  trackingNumber: string | null;
  createdAt: string;
  /** Wallet charge stamped at request (2026-08-25). null = pre-fee order or
   *  reward-prize shipment — hide the fee lines rather than showing RM 0. */
  shippingFee: number | null;
  insuranceFee: number | null;
  items: DeliveryOrderItemView[];
  /** The shipping snapshot taken when the order was placed — NOT a live read of
   *  the address book, so editing or removing the book entry never rewrites it. */
  address: {
    name: string;
    line1: string;
    line2: string | null;
    city: string;
    province: string | null;
    postalCode: string;
    countryCode: string;
    phone: string | null;
  };
  // Operator-uploaded proof-of-delivery photo URLs (empty when none). Backend
  // key is `proof_images`; renamed here to match the camelCase view convention.
  proofImages: string[];
};

export type DeliveryOrdersResult =
  | { ok: true; orders: DeliveryOrderView[] }
  | { ok: false; error: string; needsAuth?: boolean };

export type RequestDeliveryResult =
  | { ok: true; orderId: string }
  | { ok: false; error: string; needsAuth?: boolean };

/** Outcome of shipping a mixed selection — see `shipVaultCards`. */
export type ShipVaultResult =
  | {
      ok: true;
      /** Pulls that are on their way; the vault drops these rows. */
      shippedIds: string[];
      /** Pulls that stayed, and why — rendered per card, not swallowed. */
      skipped: { pullId: string; reason: string }[];
    }
  | { ok: false; error: string; needsAuth?: boolean };

export type EditAddressResult =
  { ok: true } | { ok: false; error: string; needsAuth?: boolean };

export type AddressView = {
  id: string;
  /** `firstName lastName`, for display. */
  name: string;
  // Kept SPLIT as well as joined: the edit form has to seed the two inputs back,
  // and re-splitting `name` on whitespace mangles every two-word given name.
  firstName: string;
  lastName: string;
  line1: string;
  line2: string | null;
  city: string;
  province: string | null;
  postalCode: string;
  countryCode: string;
  phone: string | null;
};

interface BackendDeliveryOrder {
  id: string;
  status: DeliveryOrderView['status'];
  tracking_number: string | null;
  shipping_fee?: number | null;
  insurance_fee?: number | null;
  proof_images?: string[] | null;
  created_at: string;
  address: {
    name: string;
    address_1?: string | null;
    address_2?: string | null;
    city: string;
    province?: string | null;
    postal_code?: string | null;
    country_code: string;
    phone?: string | null;
  };
  items: {
    pull_id: string;
    card: {
      handle: string;
      name: string;
      image: string;
      slab_image?: string | null;
    } | null;
  }[];
}

// The address book goes through `sdk.store.customer.*` — built-in Medusa
// endpoints (exception 3 in lib/store.ts's header), so those three actions
// catch a THROWN error and have no port `Failure` to hand `friendlyFailure`.
// They append the shared transport tier here instead, which is exactly what
// friendlyFailure does for every other delivery call.
const ADDRESS_RULES: ErrorRule[] = [...DELIVERY_RULES, ...TRANSPORT_RULES];

const LOGIN_FIRST = 'Please log in first.';
const LOGIN_TO_VIEW_ORDERS = 'Please log in to view your orders.';

/**
 * A port `Failure` in this file's vocabulary. No cookie at all (the call never
 * left — `status` is undefined) keeps the action's own logged-out copy;
 * anything the backend actually said goes through the caller's rules table,
 * with `needsAuth` when it was a 401.
 */
function deliveryFailure(
  f: Failure,
  loggedOut: string,
  rules: readonly ErrorRule[] = DELIVERY_RULES,
): { ok: false; error: string; needsAuth?: boolean } {
  if (f.kind === 'unauthenticated' && f.status === undefined) {
    return { ok: false, error: loggedOut, needsAuth: true };
  }
  return {
    ok: false,
    error: friendlyFailure(f, rules, DELIVERY_FALLBACK),
    needsAuth: f.kind === 'unauthenticated',
  };
}

export async function getDeliveryOrders(): Promise<DeliveryOrdersResult> {
  const r = await store.get('/store/delivery-orders', DeliveryOrdersPageSchema);
  if (!r.ok) return deliveryFailure(r, LOGIN_TO_VIEW_ORDERS);
  // The assertion widens the parse output to the fields the mapper also READS
  // but DeliveryOrderSchema deliberately does not guard — they ride the
  // `looseObject` typed `unknown` (same seam as getVault's items).
  const raw = r.data.items as unknown as BackendDeliveryOrder[];
  const orders: DeliveryOrderView[] = raw.map((o) => ({
    id: o.id,
    status: o.status,
    trackingNumber: o.tracking_number,
    createdAt: o.created_at,
    shippingFee: o.shipping_fee ?? null,
    insuranceFee: o.insurance_fee ?? null,
    address: {
      name: o.address?.name ?? '',
      line1: o.address?.address_1 ?? '',
      line2: o.address?.address_2 ?? null,
      city: o.address?.city ?? '',
      province: o.address?.province ?? null,
      postalCode: o.address?.postal_code ?? '',
      countryCode: o.address?.country_code ?? '',
      phone: o.address?.phone ?? null,
    },
    proofImages: o.proof_images ?? [],
    items: (o.items ?? []).map((it) => ({
      pullId: it.pull_id,
      card: it.card ? toCardView(it.card) : null,
    })),
  }));
  return { ok: true, orders };
}

export async function requestDelivery(
  pullIds: string[],
  addressId: string,
): Promise<RequestDeliveryResult> {
  if (!Array.isArray(pullIds) || pullIds.length === 0) {
    return { ok: false, error: 'Select at least one card.' };
  }
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    return { ok: false, error: 'Choose a shipping address.' };
  }
  // Unchecked at the envelope: the batch is charged and committed by the time
  // this body arrives, so a missing `order_id` keeps its own copy below rather
  // than becoming a generic "try again".
  const r = await store.post('/store/delivery-orders', UncheckedSchema, {
    pull_ids: pullIds,
    address_id: addressId,
  });
  if (!r.ok) return deliveryFailure(r, LOGIN_FIRST);
  // JSON parsing accepts null and malformed nested objects; preserve the
  // pre-port projection fallback without changing the Store contract.
  try {
    const orderId = (r.data as { order_id?: string }).order_id;
    if (!orderId) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, orderId };
  } catch (error) {
    logger.error('[delivery] response projection failed:', error);
    return { ok: false, error: DELIVERY_FALLBACK, needsAuth: false };
  }
}

// Re-point a pre-ship delivery order at a different saved address. The backend
// only permits this while the order is `requested` or `processed` (it returns
// NOT_ALLOWED→400 otherwise — from `ready_to_ship` on, a printed label must not
// diverge from the address); the UI hides the affordance for other statuses.
export async function editDeliveryAddress(
  orderId: string,
  addressId: string,
): Promise<EditAddressResult> {
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return { ok: false, error: 'Missing order.' };
  }
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    return { ok: false, error: 'Choose a shipping address.' };
  }
  // The response is not read — a 2xx IS the answer.
  const r = await store.post(
    `/store/delivery-orders/${encodeURIComponent(orderId)}/address`,
    UncheckedSchema,
    { address_id: addressId },
  );
  if (!r.ok) return deliveryFailure(r, LOGIN_FIRST);
  return { ok: true };
}

export type CancelDeliveryResult =
  | { ok: true; status: DeliveryOrderView['status'] }
  | { ok: false; error: string; needsAuth?: boolean };

// Cancel-specific error vocabulary — the generic DELIVERY_RULES map 404/409 to
// request-delivery copy ("card or address not found") that would mislead here.
// Order matters: "already canceled" must win before the broader shipped rule.
// No rate-limit rule, for the same reason DELIVERY_RULES has none: the copy
// WAS the shared sentence, so friendlyFailure answers a 429 now — but only
// LAST, behind every rule below, including /not found|404/i at the tail (same
// latent hazard as DELIVERY_RULES/VAULT_RULES: a rate-limited response reads
// "<label> Try again in Ns.", and an N containing "404" would hit that rule
// first — unreachable today because this surface's rate limit defaults to a
// <=60s window, see delivery-errors.ts).
const CANCEL_RULES: ErrorRule[] = [
  [UNAUTHORIZED, DELIVERY_LOGIN],
  [/already canceled/i, 'This delivery is already canceled.'],
  // Backend NOT_ALLOWED once the order is out of the customer window. It fires
  // from `processed` on (the 12am cutoff) — not only after the parcel
  // physically ships — so the copy says "being prepared", which is true for
  // every status it covers.
  [
    /no longer be canceled|not allowed|ready to ship|shipped|delivered/i,
    'This order is already being prepared for shipping and can no longer be canceled — please contact support.',
  ],
  [/not found|404/i, 'That order was not found.'],
];

// Cancel an order the customer still owns the decision on (`requested`, i.e.
// before the 12am cutoff) — the cards return to their vault. From `processed`
// on the backend refuses: purchasing has started on it, so cancelling is an
// operator/support action. The UI hides the affordance for the same statuses.
export async function cancelDeliveryOrder(
  orderId: string,
): Promise<CancelDeliveryResult> {
  if (typeof orderId !== 'string' || orderId.trim() === '') {
    return { ok: false, error: 'Missing order.' };
  }
  const r = await store.post(
    `/store/delivery-orders/${encodeURIComponent(orderId)}/cancel`,
    CancelDeliverySchema,
    undefined,
  );
  if (!r.ok) return deliveryFailure(r, LOGIN_FIRST, CANCEL_RULES);
  // A 2xx means the cancel happened — a drifted body must not false-fail it
  // (CancelDeliverySchema is soft to the root), so fall back to the status the
  // backend just transitioned to.
  return { ok: true, status: r.data?.status ?? 'canceled' };
}

// Read the customer's address book (built-in Medusa field — no custom route).
export async function getAddresses(): Promise<AddressView[]> {
  const customer = await getCustomer();
  if (!customer) return [];
  return (customer.addresses ?? []).map(
    (a: HttpTypes.StoreCustomerAddress) => ({
      id: a.id,
      name: [a.first_name, a.last_name].filter(Boolean).join(' '),
      firstName: a.first_name ?? '',
      lastName: a.last_name ?? '',
      line1: a.address_1 ?? '',
      line2: a.address_2 ?? null,
      city: a.city ?? '',
      province: a.province ?? null,
      postalCode: a.postal_code ?? '',
      countryCode: a.country_code ?? '',
      phone: a.phone ?? null,
    }),
  );
}

export type AddAddressInput = {
  firstName: string;
  lastName: string;
  address1: string;
  address2?: string;
  city: string;
  province?: string;
  postalCode: string;
  countryCode: string;
  phone?: string;
};
export type AddAddressResult =
  | { ok: true; addressId: string }
  | { ok: false; error: string; needsAuth?: boolean };

export type EditAddressBookResult =
  { ok: true } | { ok: false; error: string; needsAuth?: boolean };

// ONE snake_case mapping for both create and update.
//
// The optional fields send an explicit `null`, NOT `undefined` — this is the
// load-bearing bit, not a style choice. `JSON.stringify` drops an `undefined`
// value entirely, and the update route is a PARTIAL write: a key that never
// reaches the wire leaves the stored value untouched. So `|| undefined` meant
// an operator clearing their phone number got a 200, an optimistic row showing
// it blank, and the old number still on the server after a reload. `null` is
// what "no value" has to look like on the update path, and Medusa's Create and
// Update schemas both type these `string | null`, so create is unaffected.
const addressBody = (input: AddAddressInput) => ({
  first_name: input.firstName,
  last_name: input.lastName,
  address_1: input.address1,
  address_2: input.address2 || null,
  city: input.city,
  province: input.province || null,
  postal_code: input.postalCode,
  country_code: input.countryCode.trim().toUpperCase(),
  phone: input.phone || null,
});

// The fields a parcel cannot ship without. Same gate on add and edit —
// an edit that blanks the street is as unshippable as an add that omits it.
const missingRequired = (input: AddAddressInput): boolean =>
  // Either name will do: the backend's snapshotAddress joins them and only
  // refuses a row with neither.
  (!input.firstName?.trim() && !input.lastName?.trim()) ||
  !input.address1?.trim() ||
  !input.city?.trim() ||
  !input.postalCode?.trim() ||
  !input.countryCode?.trim() ||
  // The state, for MY only. It picks the shipping zone (delivery-fee.ts) and
  // the postcode is customer-typed, so without a state an East Malaysian town
  // outside the 12-name city allowlist is billed the West rate — RM20 short,
  // every shipment, with no server-side signal.
  //
  // Scoped to MY deliberately: this gate is shared by addAddress AND
  // updateAddress, so an unconditional requirement would make every
  // pre-existing non-MY address uneditable until a state was invented for it.
  // Singapore has no states (the forms store "Singapore"), and only MY and
  // SG ship at all — workflows/steps/request-delivery.ts refuses the rest.
  (input.countryCode?.trim().toUpperCase() === 'MY' && !input.province?.trim());

// Only MY and SG ship, so an address in any other "country" is dead on arrival.
// The forms took free text until 2026-10-20 and customers typed the phone code
// ("60"), "MALAYSIA" or an area code: 74 Malaysian addresses saved that way and
// the delivery modal refused every one. Shared by add and edit like the gate
// above.
const COUNTRY_ERROR = 'Choose Malaysia or Singapore as the country.';

// What a delivery request would refuse anyway. Saved regardless, the row looks
// fine in the book and the customer only meets the refusal at Confirm.
function addressRefusal(input: AddAddressInput): string | null {
  if (missingRequired(input)) return 'Fill in the required address fields.';
  if (!isShippableCountry(input.countryCode)) return COUNTRY_ERROR;
  if (!isShippablePostcode(input.postalCode, input.countryCode)) {
    // The same sentence as the backend's postcodeMessage.
    return `Enter ${postcodeHint(input.countryCode)} for this address.`;
  }
  return null;
}

// The address-book phone is the actual SOURCE of a delivery order's
// ship_phone — the backend's profile-phone fallback (request-delivery.ts)
// only fires when it's BLANK, so a garbage address phone here would SUPPRESS
// that validated fallback. Same rule, same copy, as the profile phone
// (customer.ts): empty stays optional (→ null via addressBody below), a
// non-empty value must normalize to E.164 or the action rejects. Shared by
// both addAddress and updateAddress so the rule can't drift between them.
function validateAddressPhone(
  phone: string | undefined,
): { ok: true; phone: string | undefined } | { ok: false; error: string } {
  const trimmed = phone?.trim();
  if (!trimmed) return { ok: true, phone: undefined };
  const normalized = normalizePhone(trimmed);
  if (!normalized) {
    return {
      ok: false,
      error: 'Please enter a valid phone number for the selected country.',
    };
  }
  return { ok: true, phone: normalized };
}

// Create an address in the Medusa customer address book via the built-in SDK.
// Returns the new address id for immediate selection in the delivery flow.
export async function addAddress(
  input: AddAddressInput,
): Promise<AddAddressResult> {
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  const refusal = addressRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  const phoneCheck = validateAddressPhone(input.phone);
  if (!phoneCheck.ok) return phoneCheck;
  try {
    // The new row is the one that wasn't there before. Its place in the list
    // means nothing: Medusa's route refetches `addresses` with no ORDER BY, so
    // an updated row can read last, and that wrong id is where the parcel goes.
    const { customer: before, stale } = await getCustomerSession();
    if (!before) {
      return {
        ok: false,
        error: stale ? LOGIN_FIRST : 'Address was not saved. Please try again.',
        needsAuth: stale,
      };
    }
    const known = new Set((before.addresses ?? []).map((a) => a.id));
    const { customer } = await sdk.store.customer.createAddress(
      addressBody({ ...input, phone: phoneCheck.phone }),
      {},
      { Authorization: `Bearer ${token}` },
    );
    const created = (customer.addresses ?? []).find((a) => !known.has(a.id));
    if (!created?.id) {
      return { ok: false, error: 'Address was not saved. Please try again.' };
    }
    return { ok: true, addressId: created.id };
  } catch (error) {
    logger.error('[delivery] add address failed:', error);
    return {
      ok: false,
      error: friendlyError(error, ADDRESS_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// Edit a saved address in place. NOTE: a delivery order snapshots the address
// at request time (ship_* columns on delivery_order), so this never re-routes a
// parcel that is already on its way — changing where an existing order ships is
// `editDeliveryAddress` above, which re-points it at a book entry.
export async function updateAddress(
  addressId: string,
  input: AddAddressInput,
): Promise<EditAddressBookResult> {
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    return { ok: false, error: 'Missing address.' };
  }
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  const refusal = addressRefusal(input);
  if (refusal) return { ok: false, error: refusal };
  const phoneCheck = validateAddressPhone(input.phone);
  if (!phoneCheck.ok) return phoneCheck;
  try {
    await sdk.store.customer.updateAddress(
      addressId,
      addressBody({ ...input, phone: phoneCheck.phone }),
      {},
      { Authorization: `Bearer ${token}` },
    );
    return { ok: true };
  } catch (error) {
    logger.error(`[delivery] update address '${addressId}' failed:`, error);
    return {
      ok: false,
      error: friendlyError(error, ADDRESS_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// Remove an address from the book. Safe against in-flight orders for the same
// reason as `updateAddress`: the order carries its own snapshot.
export async function deleteAddress(
  addressId: string,
): Promise<EditAddressBookResult> {
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    return { ok: false, error: 'Missing address.' };
  }
  const token = await getAuthToken();
  if (!token)
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  try {
    await sdk.store.customer.deleteAddress(addressId, {
      Authorization: `Bearer ${token}`,
    });
    return { ok: true };
  } catch (error) {
    logger.error(`[delivery] delete address '${addressId}' failed:`, error);
    return {
      ok: false,
      error: friendlyError(error, ADDRESS_RULES, DELIVERY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

/**
 * How many prize cards can still ship today (the per-customer daily cap), or
 * null when it cannot be read — the sheet then prices every selected prize and
 * the backend's cap still decides.
 */
export async function getPrizeShippingAllowance(): Promise<{
  perDay: number;
  remaining: number;
} | null> {
  const r = await store.get('/store/rewards/withdraw', PrizeAllowanceSchema);
  return r.ok ? { perDay: r.data.per_day, remaining: r.data.remaining } : null;
}

/**
 * Ship a vault selection that may mix ordinary cards with prize (reward) cards
 * as ONE order through POST /store/delivery-orders, so the parcel pays one
 * shipping fee (2026-10-23). Prize cards used to go one at a time through
 * POST /store/rewards/withdraw, each its own order paying the zone fee again.
 *
 * The backend checks the daily prize cap under its lock and refuses the whole
 * request past it, so pass only the prizes today's allowance covers
 * (getPrizeShippingAllowance).
 */
export async function shipVaultCards(
  normalPullIds: string[],
  rewardPullIds: string[],
  addressId: string,
): Promise<ShipVaultResult> {
  const pullIds = [...normalPullIds, ...rewardPullIds];
  if (pullIds.length === 0) {
    return { ok: false, error: 'Select at least one card.' };
  }
  const res = await requestDelivery(pullIds, addressId);
  return res.ok ? { ok: true, shippedIds: pullIds, skipped: [] } : res;
}
