import type { HttpTypes } from '@medusajs/types';

export const DELIVERY_STATUSES = [
  'requested',
  'processed',
  'ready_to_ship',
  'shipped',
  'completed',
  'canceled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

// Customer-facing wording for a delivery status. Every customer-visible string
// MUST go through this: the raw enum tokens are snake_case ("ready_to_ship"),
// and "completed" is operator vocabulary — a customer is told their order was
// "delivered". Record<DeliveryStatus, string> makes it exhaustive, so a new
// status is a type error here rather than a leaked token in production copy.
// Named …_WORD, not …_LABEL: the admin dashboard has its own operator-facing
// DELIVERY_STATUS_LABEL (Title Case) in apps/admin/src/lib/format.ts, and one
// name for two different vocabularies is how the wrong one gets imported.
// Two layers on purpose. The CANONICAL map is Record<DeliveryStatus, string>,
// so it stays exhaustive — a new status is a type error here rather than a
// leaked token in production copy. The exported OVERLAY widens the key type to
// `string` and adds the legacy expand-window tokens (packing/delivered), which
// map onto the canonical customer words so a rollback-era row never leaks
// operator vocabulary; callers index it with a raw `order.status`. The overlay's
// two extra keys die with the CONTRACT migration named in
// Migration20260727000000 — the canonical map outlives them.
const CANONICAL_CUSTOMER_WORD: Record<DeliveryStatus, string> = {
  requested: 'requested',
  processed: 'processed',
  ready_to_ship: 'ready to ship',
  shipped: 'shipped',
  completed: 'delivered',
  canceled: 'canceled',
};
export const CUSTOMER_STATUS_WORD: Record<string, string> = {
  ...CANONICAL_CUSTOMER_WORD,
  packing: 'processed',
  delivered: 'delivered',
};

// The customer's own cancel window closes at the 12am cutoff: once the nightly
// stock run moves an order out of `requested` (to processed, purchasing starts
// buying its cards) only the operator may cancel it (owner, 2026-10-28).
// Deliberately NARROWER than ALLOWED below, which still routes processed /
// ready_to_ship -> canceled for the admin surface. Checked twice: by the
// store cancel route up front, and under the order's lock in
// transitionDeliveryOrderStatus (allowedFrom), so a cancel racing the 12am
// run cannot land on the order the run just moved.
export const CUSTOMER_CANCELABLE: readonly string[] = ['requested'];

/** The refusal a customer sees when their order is out of that window. */
export const customerCancelRefusal = (status: string): string =>
  status === 'canceled'
    ? 'This delivery is already canceled.'
    : // Human wording, never the raw enum: "completed" is operator vocabulary
      // and "ready_to_ship" is snake_case (same rule as the address-edit lock).
      `This delivery is already ${CUSTOMER_STATUS_WORD[status] ?? status} and can no longer be canceled — please contact support.`;

type PullLike = {
  id: string;
  customer_id: string;
  status: string;
  source?: string | null;
};

export type DeliveryRequestVerdict =
  | 'ok'
  | 'empty'
  | 'duplicate'
  | 'not_found'
  | 'forbidden'
  | 'already_delivering' // e.g. double-submit — pull is in a pending delivery
  | 'already_delivered'
  | 'bought_back'
  | 'not_vaulted' // fallback for any other non-vaulted status
  | 'reward_source'
  | 'free_locked';

// Pure validation for a batch delivery request. `fetchedPulls` is whatever the
// DB returned for `requestedIds`; ownership failure and unknown id BOTH map to
// the same caller-facing 404 upstream (no existence leak), but we distinguish
// them here for precise logging/branching.
//
// `lockedIds` is the caller's lockedPullIds(callerId, fetchedPulls) — the
// ONE lock rule (free welcome pull, daily task card), resolved once per
// request and never stored on the pull, so the customer's first paid open
// lifts it with zero writes (spec 2026-08-14).
//
// `prizesShipHere` is the generic delivery path's flag: prize pulls ride in
// the same parcel as the vault cards (2026-10-23) and pass on to the lock
// check. recordRewardWithdrawal never sets it — it ships only what earns the
// 'reward_source' verdict.
export function validateDeliveryRequest(
  fetchedPulls: PullLike[],
  requestedIds: string[],
  callerId: string,
  lockedIds: ReadonlySet<string>,
  opts: { prizesShipHere?: boolean } = {},
): DeliveryRequestVerdict {
  if (requestedIds.length === 0) return 'empty';
  if (new Set(requestedIds).size !== requestedIds.length) return 'duplicate';

  const byId = new Map(fetchedPulls.map((p) => [p.id, p]));
  for (const id of requestedIds) {
    const pull = byId.get(id);
    if (!pull) return 'not_found';
    if (pull.customer_id !== callerId) return 'forbidden';
    if (pull.status !== 'vaulted') {
      // Name the actual blocker (sim P3 #9: a double-submit read as "cards
      // vanished"). Safe to reveal — ownership was already verified above.
      if (pull.status === 'delivering') return 'already_delivering';
      if (pull.status === 'delivered') return 'already_delivered';
      if (pull.status === 'bought_back') return 'bought_back';
      return 'not_vaulted';
    }
    // Without the flag this is a ROUTING verdict, not a refusal: the caller
    // (recordRewardWithdrawal) ships exactly the pulls that earn it.
    if (pull.source === 'reward' && !opts.prizesShipHere) {
      return 'reward_source';
    }
    // A locked pull ships only after the customer's first PAID open — same
    // lock the buyback step applies (lockedPullIds).
    if (lockedIds.has(pull.id)) return 'free_locked';
  }
  return 'ok';
}

export type TransitionVerdict =
  | 'ok'
  | 'invalid_transition'
  | 'tracking_required';

// Allowed admin transitions. Cancel is only legal before the parcel ships
// (a shipped parcel can't revert to the vault). completed/canceled are terminal.
//
// Same two-layer shape as CUSTOMER_STATUS_WORD, for the same reason.
// CANONICAL_ALLOWED is Record<DeliveryStatus, …>, so the real pipeline keeps
// its exhaustiveness check — adding a status without giving it transitions is a
// type error. The overlay widens the key to `string` and adds the legacy
// tokens: Migration20260727000000 deliberately leaves the DB CHECK on the UNION
// of the old and new vocabularies (expand phase), so old code — rolled back, or
// still serving during the PRE_DEPLOY window — can write the pre-rename
// 'packing'/'delivered' tokens. Without those overlay keys every move out of
// 'packing' returns invalid_transition, stranding the order AND leaving its
// pulls stuck in 'delivering'. Delete the overlay's two keys in the same release
// as the CONTRACT migration named in Migration20260727000000.
const CANONICAL_ALLOWED: Record<DeliveryStatus, DeliveryStatus[]> = {
  requested: ['processed', 'canceled'],
  processed: ['ready_to_ship', 'canceled'],
  ready_to_ship: ['shipped', 'canceled'],
  shipped: ['completed'],
  completed: [],
  canceled: [],
};
const ALLOWED: Record<string, DeliveryStatus[]> = {
  ...CANONICAL_ALLOWED,
  // Legacy pre-rename tokens. 'packing' is what 'processed' is now, so one hop
  // lands the row in the new pipeline (or cancels it — the pull restore in
  // transitionDeliveryOrderStatus is keyed on `to`, so delivering → vaulted
  // still runs). 'delivered' is what 'completed' is now: terminal.
  packing: ['processed', 'canceled'],
  delivered: [],
};

// `from` is `string`, not DeliveryStatus: it is whatever the row actually
// holds, which may be a legacy token (see ALLOWED). Anything unrecognized
// falls through to invalid_transition. `to` stays narrow — it is admin input.
export function validateDeliveryStatusTransition(
  from: string,
  to: DeliveryStatus,
  hasTracking: boolean,
): TransitionVerdict {
  if (!ALLOWED[from]?.includes(to)) return 'invalid_transition';
  if (to === 'shipped' && !hasTracking) return 'tracking_required';
  return 'ok';
}

// --- Shipping fee (2026-08-25 operator spec) -------------------------------
// West Malaysia RM15, East Malaysia RM35. Shipment protection is included up
// to RM200 of order card value; above that, 5% insurance on the FULL order
// value is MANDATORY (operator decision 2026-08-25 — the English brief said
// "required", the optional reading was rejected). Malaysia and Singapore only
// (Singapore RM50 since 2026-10-14): the request steps refuse any other
// country, so a fee is always computable.
export const WEST_SHIPPING_MYR = 15;
export const EAST_SHIPPING_MYR = 35;
// Singapore, shipped direct (operator decision 2026-10-14): flat RM50, and
// every delivery pays its zone's fee, prize cards included.
export const SINGAPORE_SHIPPING_MYR = 50;
export const PROTECTION_INCLUDED_MYR = 200;
export const INSURANCE_RATE = 0.05;

export type DeliveryFee = {
  shipping: number;
  /** 0 when the order value is at or under PROTECTION_INCLUDED_MYR. */
  insurance: number;
  total: number;
};

// ONE copy of the shipping-country rule for every write path (request step,
// prize route, address edit route) so the guard and its copy can't drift.
export const SHIPPING_COUNTRIES_MESSAGE =
  'We currently ship within Malaysia and Singapore only.';
/** The countries a delivery can go to: Malaysia and (since 2026-10-14)
 *  Singapore, each with its own rate below. */
export function isShippableCountry(countryCode: string): boolean {
  const cc = countryCode.trim().toUpperCase();
  return cc === 'MY' || cc === 'SG';
}
const isSingapore = (countryCode: string | null | undefined): boolean =>
  (countryCode ?? '').trim().toUpperCase() === 'SG';

// East Malaysia = Labuan 87xxx, Sabah 88xxx–91xxx, Sarawak 93xxx–98xxx — one
// contiguous numeric range (92xxx is unassigned in Malaysia's plan).
export function isEastMalaysiaPostcode(postalCode: string): boolean {
  const digits = postalCode.trim();
  if (!/^\d{5}$/.test(digits)) return false;
  const n = Number(digits);
  return n >= 87000 && n <= 98999;
}

// Every Malaysian address has a 5-digit postcode. Anything else can't be
// zoned, and a zone that can't be derived used to fall through to the CHEAP
// rate — so an unparseable postcode is refused at the door instead
// (security review 2026-08-25).
export function isShippablePostcode(
  postalCode: string,
  countryCode: string = 'MY',
): boolean {
  // Singapore postcodes are six digits; Malaysian ones five.
  return (isSingapore(countryCode) ? /^\d{6}$/ : /^\d{5}$/).test(
    postalCode.trim(),
  );
}

/** The refusal for a postcode isShippablePostcode rejects, per country. */
export function postcodeMessage(countryCode: string): string {
  return isSingapore(countryCode)
    ? 'Enter a valid 6-digit Singapore postcode for this address.'
    : 'Enter a valid 5-digit Malaysian postcode for this address.';
}

export type DeliveryZone = 'west' | 'east' | 'sg';

// An address that names Singapore (or "Singapura", the Malay spelling) in its
// state or city. Billed the Singapore rate whatever country code was typed,
// the same way a Sabah address with a KL postcode is billed East: the dearer
// reading wins. NOT matched on the street lines: a Malaysian "Jalan Singapura"
// would be over-billed RM50 with no way to correct it.
const SINGAPORE_PLACE_RE = /\b(singapore|singapura)\b/i;

// The East Malaysian states + their major localities. Matched on the address's
// province AND city because the postcode alone is customer-typed: a Sabah
// customer entering a KL postcode would otherwise be billed West RM15 for an
// East parcel (security review 2026-08-25, MEDIUM). Word-boundary anchored so
// a West place name can't collide on a substring.
const EAST_PLACE_RE =
  /\b(sabah|sarawak|labuan|kota\s*kinabalu|kuching|sandakan|tawau|miri|sibu|bintulu|lahad\s*datu|keningau)\b/i;

// The zone actually billed: the MORE EXPENSIVE of what the postcode says and
// what the state/city says. Both inputs are customer-supplied, so the rule is
// deliberately asymmetric — a mismatch bills East rather than under-charging a
// real East Malaysian shipment.
export function deliveryZone(
  postalCode: string,
  province: string | null | undefined,
  city: string | null | undefined,
  countryCode?: string | null,
): DeliveryZone {
  const place = [province, city].filter(Boolean).join(' ');
  // Singapore is the dearest zone, so it is checked first.
  if (isSingapore(countryCode) || SINGAPORE_PLACE_RE.test(place)) return 'sg';
  if (isEastMalaysiaPostcode(postalCode)) return 'east';
  return EAST_PLACE_RE.test(place) ? 'east' : 'west';
}

export const ZONE_SHIPPING_MYR: Record<DeliveryZone, number> = {
  west: WEST_SHIPPING_MYR,
  east: EAST_SHIPPING_MYR,
  sg: SINGAPORE_SHIPPING_MYR,
};

const toCents = (n: number) => Math.round(n * 100) / 100;

// `province`/`city` are optional so the storefront's preview (which has the
// same address fields) and the authoritative backend call share one signature.
// Omitting them degrades to the postcode-only zone — never pass them as
// undefined on the charging path; snapshotAddress always carries both.
export function computeDeliveryFee(
  postalCode: string,
  orderValueMyr: number,
  province?: string | null,
  city?: string | null,
  countryCode?: string | null,
): DeliveryFee {
  const shipping =
    ZONE_SHIPPING_MYR[deliveryZone(postalCode, province, city, countryCode)];
  const insurance =
    orderValueMyr > PROTECTION_INCLUDED_MYR
      ? toCents(orderValueMyr * INSURANCE_RATE)
      : 0;
  return { shipping, insurance, total: toCents(shipping + insurance) };
}

// One parcel pays ONE shipping fee (2026-10-23): prize cards sent with vault
// cards ride in the vault order instead of shipping as their own order and
// paying the zone fee again. Insurance is kept exactly as the old split
// charged it — the vault cards on their combined value, each prize on its own
// value — so shipping them together never costs more than separately.
export function computeParcelFee(
  postalCode: string,
  vaultValueMyr: number,
  prizeValuesMyr: number[],
  province?: string | null,
  city?: string | null,
  countryCode?: string | null,
): DeliveryFee {
  const fee = (value: number) =>
    computeDeliveryFee(postalCode, value, province, city, countryCode);
  const { shipping, insurance: vaultInsurance } = fee(vaultValueMyr);
  const insurance = toCents(
    prizeValuesMyr.reduce((sum, v) => sum + fee(v).insurance, vaultInsurance),
  );
  return { shipping, insurance, total: toCents(shipping + insurance) };
}

export type AddressSnapshot = {
  ship_name: string;
  ship_address_1: string;
  ship_address_2: string | null;
  ship_city: string;
  ship_province: string | null;
  ship_postal_code: string;
  ship_country_code: string;
  ship_phone: string | null;
};

// Denormalize a Medusa customer address into the order snapshot. Returns null
// when a shippable-required field is missing (the caller turns that into a
// clean INVALID_DATA error). province/address_2/phone are optional.
export function snapshotAddress(
  addr: Partial<HttpTypes.StoreCustomerAddress>,
): AddressSnapshot | null {
  const name = [addr.first_name, addr.last_name]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (
    !name ||
    !addr.address_1 ||
    !addr.city ||
    !addr.postal_code ||
    !addr.country_code
  ) {
    return null;
  }
  return {
    ship_name: name,
    ship_address_1: addr.address_1,
    ship_address_2: addr.address_2 ?? null,
    ship_city: addr.city,
    ship_province: addr.province ?? null,
    ship_postal_code: addr.postal_code,
    ship_country_code: addr.country_code,
    ship_phone: addr.phone ?? null,
  };
}
