import type { HttpTypes } from "@medusajs/types";

export const DELIVERY_STATUSES = [
  "requested",
  "packing",
  "shipped",
  "delivered",
  "canceled",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

type PullLike = {
  id: string;
  customer_id: string;
  status: string;
  source?: string | null;
};

export type DeliveryRequestVerdict =
  | "ok"
  | "empty"
  | "duplicate"
  | "not_found"
  | "forbidden"
  | "not_vaulted"
  | "reward_source";

// Pure validation for a batch delivery request. `fetchedPulls` is whatever the
// DB returned for `requestedIds`; ownership failure and unknown id BOTH map to
// the same caller-facing 404 upstream (no existence leak), but we distinguish
// them here for precise logging/branching.
export function validateDeliveryRequest(
  fetchedPulls: PullLike[],
  requestedIds: string[],
  callerId: string,
): DeliveryRequestVerdict {
  if (requestedIds.length === 0) return "empty";
  if (new Set(requestedIds).size !== requestedIds.length) return "duplicate";

  const byId = new Map(fetchedPulls.map((p) => [p.id, p]));
  for (const id of requestedIds) {
    const pull = byId.get(id);
    if (!pull) return "not_found";
    if (pull.customer_id !== callerId) return "forbidden";
    if (pull.status !== "vaulted") return "not_vaulted";
    // Reward prizes ship ONLY via recordRewardWithdrawal (redemption gate +
    // daily cap + is_reward stamping) — never via the generic delivery path.
    if (pull.source === "reward") return "reward_source";
  }
  return "ok";
}

export type TransitionVerdict = "ok" | "invalid_transition" | "tracking_required";

// Allowed admin transitions. Cancel is only legal before the parcel ships
// (a shipped parcel can't revert to the vault). delivered/canceled are terminal.
const ALLOWED: Record<DeliveryStatus, DeliveryStatus[]> = {
  requested: ["packing", "canceled"],
  packing: ["shipped", "canceled"],
  shipped: ["delivered"],
  delivered: [],
  canceled: [],
};

export function validateDeliveryStatusTransition(
  from: DeliveryStatus,
  to: DeliveryStatus,
  hasTracking: boolean,
): TransitionVerdict {
  if (!ALLOWED[from]?.includes(to)) return "invalid_transition";
  if (to === "shipped" && !hasTracking) return "tracking_required";
  return "ok";
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
  const name = [addr.first_name, addr.last_name].filter(Boolean).join(" ").trim();
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
