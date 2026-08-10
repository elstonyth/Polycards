import { MedusaError } from '@medusajs/framework/utils';
import { RARITIES, type TierRangeMap } from '@acme/odds-math';
import {
  MAX_PUBLISHED_DECIMALS,
  PUBLISHED_DECIMALS_DEFAULT,
  type PackWriteInput,
  type PublishedOdds,
} from '../../../workflows/steps/create-pack';
import { FLAT_PERCENT } from '../../../modules/packs/buyback-rate';
import { validateTierRangeMap } from '../../../modules/packs/tier-settings-validate';

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TEXT = 512;
const MAX_URL = 2048;
// http(s) or storefront-relative — the (?!\/) excludes protocol-relative
// `//host/...` URLs, which would silently point at a foreign host.
const IMAGE_RE = /^(https?:\/\/|\/(?!\/))/;

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

const reqStr = (b: Record<string, unknown>, key: string): string => {
  const v = b[key];
  if (typeof v !== 'string' || v.trim() === '') bad(`'${key}' is required.`);
  const s = (b[key] as string).trim();
  if (s.length > MAX_TEXT) bad(`'${key}' is too long (max ${MAX_TEXT} chars).`);
  return s;
};

// Image: required, length-capped, restricted to http(s) URLs or storefront-
// relative paths (blocks oversized data: URIs and odd schemes).
const imageStr = (b: Record<string, unknown>, key: string): string => {
  const v = b[key];
  if (typeof v !== 'string' || v.trim() === '') bad(`'${key}' is required.`);
  const s = (b[key] as string).trim();
  if (s.length > MAX_URL) bad(`'${key}' is too long (max ${MAX_URL} chars).`);
  if (!IMAGE_RE.test(s)) {
    bad(`'${key}' must be an http(s) URL or a /storefront path.`);
  }
  return s;
};

// Optional image, tri-state like published_odds: undefined → keep the stored
// value (a writer that doesn't send the field must not clear it — deploy-skew
// safety); null/'' → explicit clear; otherwise same gate as imageStr.
const optImageStr = (
  b: Record<string, unknown>,
  key: string,
): string | null | undefined => {
  const v = b[key];
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') bad(`'${key}' must be a string or null.`);
  const s = (v as string).trim();
  if (s === '') return null;
  if (s.length > MAX_URL) bad(`'${key}' is too long (max ${MAX_URL} chars).`);
  if (!IMAGE_RE.test(s)) {
    bad(`'${key}' must be an http(s) URL or a /storefront path.`);
  }
  return s;
};

const num = (
  b: Record<string, unknown>,
  key: string,
  fallback: number,
): number => {
  if (b[key] === undefined || b[key] === null || b[key] === '') return fallback;
  const v = typeof b[key] === 'string' ? Number(b[key]) : b[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
    bad(`'${key}' must be a number >= 0.`);
  }
  return v as number;
};

// A published-odds percentage: finite, 0–100, stored rounded to the odds'
// configured decimal places (default 2, max 4 — see coercePublishedOdds).
const pct = (v: unknown, key: string, decimals: number): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) {
    bad(`'${key}' must be a number between 0 and 100.`);
  }
  const scale = 10 ** decimals;
  return Math.round((n as number) * scale) / scale;
};

// How many decimal places this pack publishes its odds at. Absent/null → the
// legacy default (2). Anything else must be an integer 0–4.
const publishedDecimals = (v: unknown): number => {
  if (v === undefined || v === null) return PUBLISHED_DECIMALS_DEFAULT;
  if (
    typeof v !== 'number' ||
    !Number.isInteger(v) ||
    v < 0 ||
    v > MAX_PUBLISHED_DECIMALS
  ) {
    bad(
      `'published_odds.decimals' must be an integer between 0 and ${MAX_PUBLISHED_DECIMALS}.`,
    );
  }
  return v as number;
};

// PUBLIC display odds. undefined → keep the stored value (writers that don't
// send the field must not clear it); null → explicit clear; object → validated
// { overall, tiers } with only the six known rarity keys kept.
const coercePublishedOdds = (v: unknown): PublishedOdds | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) {
    bad(`'published_odds' must be an object or null.`);
  }
  const o = v as Record<string, unknown>;
  const rawTiers = o.tiers;
  if (
    rawTiers !== undefined &&
    (typeof rawTiers !== 'object' ||
      rawTiers === null ||
      Array.isArray(rawTiers))
  ) {
    bad(`'published_odds.tiers' must be an object.`);
  }
  const decimals = publishedDecimals(
    (o as Record<string, unknown>).decimals,
  );
  const tiersIn = (rawTiers ?? {}) as Record<string, unknown>;
  const tiers: PublishedOdds['tiers'] = {};
  for (const r of RARITIES) {
    const t = tiersIn[r];
    if (t !== undefined && t !== null && t !== '') {
      tiers[r] = pct(t, `published_odds.tiers.${r}`, decimals);
    }
  }
  return {
    overall: pct(o.overall ?? 100, 'published_odds.overall', decimals),
    tiers,
    decimals,
  };
};

// Per-pack tier price-range override. Tri-state like published_odds:
// undefined → keep the stored value; null → clear (inherit the global
// tier_settings); object → validated map (same rules as the singleton).
const coerceTierRanges = (v: unknown): TierRangeMap | null | undefined => {
  if (v === undefined) return undefined;
  if (v === null) return null;
  return validateTierRangeMap(v);
};

// Batch rank writes from the packs-list reorder arrows. Rank-only by design:
// reordering must not travel through the full-payload update (whose activation
// guard correctly rejects an active empty-pool pack and used to half-apply the
// swap when the neighbour's write succeeded).
export type ReorderInput = { order: { slug: string; rank: number }[] };

// One screenful of packs is ~10 rows; 200 bounds a malicious/buggy payload
// while never limiting a real category.
const MAX_REORDER = 200;

export function coerceReorderBody(raw: unknown): ReorderInput {
  if (!raw || typeof raw !== 'object') {
    bad('Body must be an object.');
  }
  const order = (raw as Record<string, unknown>).order;
  if (!Array.isArray(order) || order.length === 0) {
    bad(`'order' must be a non-empty array.`);
  }
  const entries = order as unknown[];
  if (entries.length > MAX_REORDER) {
    bad(`'order' is too large (max ${MAX_REORDER} entries).`);
  }
  const seen = new Set<string>();
  const out = entries.map((e, i) => {
    if (!e || typeof e !== 'object') {
      bad(`'order[${i}]' must be an object.`);
    }
    const { slug, rank } = e as Record<string, unknown>;
    if (typeof slug !== 'string' || !HANDLE_RE.test(slug)) {
      bad(`'order[${i}].slug' must be lowercase kebab-case.`);
    }
    const s = slug as string;
    if (seen.has(s)) {
      bad(`'order' repeats slug '${s}'.`);
    }
    seen.add(s);
    if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0) {
      bad(`'order[${i}].rank' must be an integer >= 0.`);
    }
    return { slug: s, rank: rank as number };
  });
  return { order: out };
}

// Coerce + validate the pack form body. `slug` comes from the route params on
// update (immutable) and from the body on create.
export function coercePackBody(raw: unknown, slug: string): PackWriteInput {
  if (!raw || typeof raw !== 'object') {
    bad('Body must be an object.');
  }
  const b = raw as Record<string, unknown>;

  if (!HANDLE_RE.test(slug)) {
    bad("'slug' must be lowercase kebab-case (letters, digits, hyphens).");
  }

  // Fail-safe default: a missing/malformed status becomes DRAFT, never active —
  // an accidentally-active pack with an empty pool breaks every spin.
  const status = b.status === 'active' ? 'active' : 'draft';

  // Buyback %: the INSTANT (on-the-spot) rate. Omitted → the flat rate (90).
  // A set rate may never undercut the flat rate — vault/inventory sells always
  // pay flat, so an instant rate below it would invert the keep/sell incentive.
  const buybackPercent = Math.trunc(num(b, 'buyback_percent', FLAT_PERCENT));
  if (buybackPercent < FLAT_PERCENT || buybackPercent > 100) {
    bad(
      `'buyback_percent' must be between the flat rate (${FLAT_PERCENT}) and 100.`,
    );
  }

  return {
    slug,
    title: reqStr(b, 'title'),
    category: reqStr(b, 'category'),
    price: num(b, 'price', 0),
    image: imageStr(b, 'image'),
    display_image: optImageStr(b, 'display_image'),
    buyback_percent: buybackPercent,
    boost: b.boost === true,
    rank: Math.trunc(num(b, 'rank', 0)),
    status,
    published_odds: coercePublishedOdds(b.published_odds),
    tier_ranges: coerceTierRanges(b.tier_ranges),
  };
}
