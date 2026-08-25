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
// `freeUnlocked` is the caller's hasPaidOpen(callerId) — resolved ONCE per
// request, never stored on the pull, so the customer's first paid open lifts
// the free-welcome lock with zero writes (spec 2026-08-14).
export function validateDeliveryRequest(
  fetchedPulls: PullLike[],
  requestedIds: string[],
  callerId: string,
  freeUnlocked: boolean,
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
    // Reward prizes ship ONLY via recordRewardWithdrawal (daily cap +
    // is_reward stamping) — never via the generic delivery path. This is a
    // ROUTING verdict, not a refusal: the vault sends these pulls to the
    // reward path rather than showing the customer a wall.
    if (pull.source === 'reward') return 'reward_source';
    // The free welcome pull ships only after the customer's first PAID open —
    // same lock the buyback step applies (modules/packs/free-pack.ts).
    if (pull.source === 'free' && !freeUnlocked) return 'free_locked';
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
// "required", the optional reading was rejected). MY-only: the request step
// refuses non-MY country codes, so a fee is always computable.
export const WEST_SHIPPING_MYR = 15;
export const EAST_SHIPPING_MYR = 35;
export const PROTECTION_INCLUDED_MYR = 200;
export const INSURANCE_RATE = 0.05;

export type DeliveryFee = {
  shipping: number;
  /** 0 when the order value is at or under PROTECTION_INCLUDED_MYR. */
  insurance: number;
  total: number;
};

// ONE copy of the MY-only rule for both write paths (request step + address
// edit route) so the guard and its customer copy can't drift.
export const MY_ONLY_MESSAGE = 'We currently ship within Malaysia only.';
export function isMalaysianAddress(countryCode: string): boolean {
  return countryCode.trim().toUpperCase() === 'MY';
}

// East Malaysia = Labuan 87xxx, Sabah 88xxx–91xxx, Sarawak 93xxx–98xxx — one
// contiguous numeric range (92xxx is unassigned in Malaysia's plan).
// ponytail: a malformed postcode bills the West rate rather than refusing the
// order; the operator reconciles the odd manual case.
export function isEastMalaysiaPostcode(postalCode: string): boolean {
  const digits = postalCode.trim();
  if (!/^\d{5}$/.test(digits)) return false;
  const n = Number(digits);
  return n >= 87000 && n <= 98999;
}

const toCents = (n: number) => Math.round(n * 100) / 100;

export function computeDeliveryFee(
  postalCode: string,
  orderValueMyr: number,
): DeliveryFee {
  const shipping = isEastMalaysiaPostcode(postalCode)
    ? EAST_SHIPPING_MYR
    : WEST_SHIPPING_MYR;
  const insurance =
    orderValueMyr > PROTECTION_INCLUDED_MYR
      ? toCents(orderValueMyr * INSURANCE_RATE)
      : 0;
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
