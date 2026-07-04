import { MedusaError } from '@medusajs/framework/utils';
import { RARITIES } from '@acme/odds-math';
import type {
  PackWriteInput,
  PublishedOdds,
} from '../../../workflows/steps/create-pack';
import { FLAT_PERCENT } from '../../../modules/packs/buyback-rate';

const HANDLE_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_TEXT = 512;
const MAX_URL = 2048;
const IMAGE_RE = /^(https?:\/\/|\/)/;

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

// A published-odds percentage: finite, 0–100, stored to 2 decimals.
const pct = (v: unknown, key: string): number => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) {
    bad(`'${key}' must be a number between 0 and 100.`);
  }
  return Math.round((n as number) * 100) / 100;
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
  const tiersIn = (rawTiers ?? {}) as Record<string, unknown>;
  const tiers: PublishedOdds['tiers'] = {};
  for (const r of RARITIES) {
    const t = tiersIn[r];
    if (t !== undefined && t !== null && t !== '') {
      tiers[r] = pct(t, `published_odds.tiers.${r}`);
    }
  }
  return { overall: pct(o.overall ?? 100, 'published_odds.overall'), tiers };
};

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
    buyback_percent: buybackPercent,
    boost: b.boost === true,
    rank: Math.trunc(num(b, 'rank', 0)),
    status,
    published_odds: coercePublishedOdds(b.published_odds),
  };
}
