/**
 * Client-side mirror of the backend shipping-fee rules
 * (backend/packages/api/src/modules/packs/delivery.ts — computeDeliveryFee).
 * Preview only: the backend recomputes and charges authoritatively at request
 * time; keep the two in sync when rates change.
 *
 * West Malaysia RM15, East Malaysia RM35 (Labuan 87xxx, Sabah 88–91xxx,
 * Sarawak 93–98xxx), Singapore RM50 (shipped direct, since 2026-10-14).
 * Protection included up to RM200 of order card value; above that, 5%
 * insurance on the FULL value is mandatory. Every delivery pays its zone's
 * shipping, prize cards included.
 */

export const WEST_SHIPPING_MYR = 15;
export const EAST_SHIPPING_MYR = 35;
export const SINGAPORE_SHIPPING_MYR = 50;
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

const isSingapore = (countryCode: string | null | undefined): boolean =>
  (countryCode ?? '').trim().toUpperCase() === 'SG';

/** Malaysia and Singapore are the only countries a delivery can go to. */
export function isShippableCountry(countryCode: string): boolean {
  const cc = countryCode.trim().toUpperCase();
  return cc === 'MY' || cc === 'SG';
}

/** A Malaysian postcode is 5 digits, a Singapore one 6; anything else can't
 *  be zoned and the backend refuses it. */
export function isShippablePostcode(
  postalCode: string,
  countryCode: string = 'MY',
): boolean {
  return (isSingapore(countryCode) ? /^\d{6}$/ : /^\d{5}$/).test(
    postalCode.trim(),
  );
}

/** What a postcode isShippablePostcode refuses must look like, per country. */
export function postcodeHint(countryCode: string): string {
  return isSingapore(countryCode)
    ? 'a valid 6-digit Singapore postcode'
    : 'a valid 5-digit Malaysian postcode';
}

export type DeliveryZone = 'west' | 'east' | 'sg';

export const EAST_PLACE_RE =
  /\b(sabah|sarawak|labuan|kota\s*kinabalu|kuching|sandakan|tawau|miri|sibu|bintulu|lahad\s*datu|keningau)\b/i;

/** An address naming Singapore (or "Singapura") in its state or city is
 *  billed the Singapore rate, whatever country code was typed (the dearer
 *  reading wins). */
export const SINGAPORE_PLACE_RE = /\b(singapore|singapura)\b/i;

/** The MOST EXPENSIVE reading of country, postcode and state/city — all are
 *  customer-typed, so a Sabah address with a KL postcode must still preview
 *  (and be charged) the East rate, and one naming Singapore the Singapore
 *  rate. */
export function deliveryZone(
  postalCode: string,
  province?: string | null,
  city?: string | null,
  countryCode?: string | null,
): DeliveryZone {
  const place = [province, city].filter(Boolean).join(' ');
  if (isSingapore(countryCode) || SINGAPORE_PLACE_RE.test(place)) return 'sg';
  if (isEastMalaysiaPostcode(postalCode)) return 'east';
  return EAST_PLACE_RE.test(place) ? 'east' : 'west';
}

const ZONE_SHIPPING_MYR: Record<DeliveryZone, number> = {
  west: WEST_SHIPPING_MYR,
  east: EAST_SHIPPING_MYR,
  sg: SINGAPORE_SHIPPING_MYR,
};

/** How each zone reads to a customer. */
export const ZONE_LABEL: Record<DeliveryZone, string> = {
  west: 'West Malaysia',
  east: 'East Malaysia',
  sg: 'Singapore',
};

const toCents = (n: number) => Math.round(n * 100) / 100;

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

// One parcel pays ONE shipping fee (2026-10-23): prize cards ride in the vault
// order. Mirrors the backend's computeParcelFee — insurance stays what separate
// orders charged: the vault cards on their combined value, each prize on its own.
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
