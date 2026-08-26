/**
 * Client-side mirror of the backend shipping-fee rules
 * (backend/packages/api/src/modules/packs/delivery.ts — computeDeliveryFee).
 * Preview only: the backend recomputes and charges authoritatively at request
 * time; keep the two in sync when rates change.
 *
 * West Malaysia RM15, East Malaysia RM35 (Labuan 87xxx, Sabah 88–91xxx,
 * Sarawak 93–98xxx). Protection included up to RM200 of order card value;
 * above that, 5% insurance on the FULL value is mandatory.
 */

export const WEST_SHIPPING_MYR = 15;
export const EAST_SHIPPING_MYR = 35;
export const PROTECTION_INCLUDED_MYR = 200;
export const INSURANCE_RATE = 0.05;

export type DeliveryFee = {
  shipping: number;
  insurance: number;
  total: number;
};

export function isEastMalaysiaPostcode(postalCode: string): boolean {
  const digits = postalCode.trim();
  if (!/^\d{5}$/.test(digits)) return false;
  const n = Number(digits);
  return n >= 87000 && n <= 98999;
}

/** Every Malaysian address has a 5-digit postcode; anything else can't be
 *  zoned and the backend refuses it. */
export function isShippablePostcode(postalCode: string): boolean {
  return /^\d{5}$/.test(postalCode.trim());
}

export type DeliveryZone = 'west' | 'east';

export const EAST_PLACE_RE =
  /\b(sabah|sarawak|labuan|kota\s*kinabalu|kuching|sandakan|tawau|miri|sibu|bintulu|lahad\s*datu|keningau)\b/i;

/** The MORE EXPENSIVE of the postcode zone and the state/city zone — the
 *  postcode alone is customer-typed, so a Sabah address with a KL postcode
 *  must still preview (and be charged) the East rate. */
export function deliveryZone(
  postalCode: string,
  province?: string | null,
  city?: string | null,
): DeliveryZone {
  if (isEastMalaysiaPostcode(postalCode)) return 'east';
  const place = [province, city].filter(Boolean).join(' ');
  return EAST_PLACE_RE.test(place) ? 'east' : 'west';
}

const toCents = (n: number) => Math.round(n * 100) / 100;

export function computeDeliveryFee(
  postalCode: string,
  orderValueMyr: number,
  province?: string | null,
  city?: string | null,
): DeliveryFee {
  const shipping =
    deliveryZone(postalCode, province, city) === 'east'
      ? EAST_SHIPPING_MYR
      : WEST_SHIPPING_MYR;
  const insurance =
    orderValueMyr > PROTECTION_INCLUDED_MYR
      ? toCents(orderValueMyr * INSURANCE_RATE)
      : 0;
  return { shipping, insurance, total: toCents(shipping + insurance) };
}
