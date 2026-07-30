import { gradeForIncludeString } from '../../../modules/packs/pricecharting-grades';
import { isPcImageUrl } from '../media/ingest-pc-image';

// Normalizer for PriceCharting's seller-collection offers (/api/offers?status=
// collection). Kept out of collection/route.ts so the mapping is unit-testable
// without booting Medusa — the route stays a thin transport, same split as
// product-image.ts beside product/route.ts.
//
// Upstream rows carry ~60 fields (UI flags, profit projections, star ratings);
// everything below is the subset the import actually uses.

export type PcOffer = {
  /** PriceCharting's per-offer id — the same product can be held twice (one
   *  raw, one graded), so this, not product_id, keys a row. Never null: a row
   *  without one is rejected below, because any fallback key would be shared by
   *  two distinct holdings of the same card at the same grade. */
  offer_id: string;
  /** PriceCharting product id — what the import prices and links against. */
  product_id: string;
  name: string;
  set: string;
  /** PriceCharting's own grade tag for this offer, verbatim ("PSA 10",
   *  "Graded 9", "Ungraded"). */
  include: string;
  condition: string;
  /** What PriceCharting values THIS offer at, in USD. Display only — the import
   *  re-reads the per-grade FMV so market_value matches what the nightly sync
   *  will later write. */
  value_usd: number | null;
  /** `include` mapped onto a PRICE_FIELDS label, or null when it names no field
   *  we price from (the operator then picks the tier during import). */
  grade: string | null;
  image: string | null;
  /** Upstream `is-card`. A real collection mixes trading cards with games and
   *  hardware; the import UI filters on this so a card storefront isn't asked
   *  to onboard a boxed Game Boy. */
  is_card: boolean;
};

/**
 * Upstream marks each row with whether the requesting account owns it. FALSE is
 * the signature of the bug that shipped once already: /api/offers without a
 * `seller` returns everyone's offers, and every row came back false. The route
 * drops those rather than trusting that PRICECHARTING_SELLER_ID is OUR id — a
 * typo'd or stale one is otherwise indistinguishable from a correct one.
 *
 * Absent is tolerated, not rejected: a correctly-scoped response has never been
 * observed with rows in it (the collection is empty), so demanding `=== true`
 * could empty a working page.
 */
export const isForeignOffer = (raw: Record<string, unknown>): boolean =>
  raw['user-viewing-own-offers'] === false;

/** Upstream offer values are integer PENNIES (number or digit string). */
export function penniesToUsd(raw: unknown): number | null {
  const n = typeof raw === 'string' ? Number(raw.replace(/[$,\s]/g, '')) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n) / 100;
}

// Same allowlist the ingest step enforces (host + bucket), not a bare https
// check: a non-PriceCharting URL is stored VERBATIM by the create step rather
// than ingested (create-product-from-pricecharting.ts), so anything that slips
// through here would be hotlinked into the catalog.
const pcImageOrNull = (raw: unknown): string | null =>
  typeof raw === 'string' && isPcImageUrl(raw) ? raw : null;

/**
 * Map one raw offer onto PcOffer. Returns null for an offer the import cannot
 * handle, so it never reaches the table:
 *  - no product id — it cannot be priced or linked;
 *  - no offer id — it cannot be told apart from another holding of the same
 *    card at the same grade, so the two would collapse into one and undercount
 *    the units held. Every offer in the live collection carries one.
 */
export function normalizeOffer(raw: Record<string, unknown>): PcOffer | null {
  const productId = raw.id != null ? String(raw.id).trim() : '';
  if (productId === '') return null;

  // A string or a finite number, nothing else. A number is accepted because
  // dropping a numerically-keyed row would empty the page in a way
  // indistinguishable from a genuinely empty collection; anything else is
  // refused because String() would coin a key rows can SHARE — `{}` becomes
  // "[object Object]" for every such row, and the scan dedupe would then treat
  // two distinct holdings as one and undercount the units held.
  const rawOfferId = raw['offer-id'];
  const offerId =
    typeof rawOfferId === 'string' ||
    (typeof rawOfferId === 'number' && Number.isFinite(rawOfferId))
      ? String(rawOfferId).trim()
      : '';
  if (offerId === '') return null;

  const include = String(raw['include-string'] ?? '');
  return {
    offer_id: offerId,
    product_id: productId,
    name: String(raw['product-name'] ?? ''),
    set: String(raw['console-name'] ?? ''),
    include,
    condition: String(raw['condition-string'] ?? ''),
    // `value` is the collection valuation; `price` is what the row is listed at
    // when the offer is for sale. Only the former is meaningful here, but fall
    // back so a row never renders a blank money cell when upstream sends one.
    value_usd: penniesToUsd(raw.value ?? raw.price),
    grade: gradeForIncludeString(include),
    image: pcImageOrNull(raw['image-url']),
    is_card: raw['is-card'] === true,
  };
}
