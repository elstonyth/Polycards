/**
 * Marketplace catalog data seam.
 *
 * Single source for the marketplace listing grid, the category tabs, and
 * card-detail lookups. Cards are read live from the Medusa + Mercur Store API
 * (`backend/`) — they are seeded as products of an "open" house seller, priced
 * in USD, with card-specific facts (fmv/points/grade/grader/set/rarity/year) on
 * `product.metadata`. See `backend/packages/api/src/scripts/seed.ts`.
 *
 * Resilience: every getter degrades gracefully if the backend is unreachable
 * (e.g. a storefront build with no running backend) — the grid falls back to an
 * empty list and card-detail falls back to the deterministic mock pool, so the
 * build never hard-fails on a transient backend outage.
 */

import type { HttpTypes } from '@medusajs/types';
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import {
  cardOrGeneric,
  type Grader,
  type MockCard,
  type Rarity,
} from '@/lib/mock/cards';

export interface MarketplaceCard {
  id: string;
  title: string;
  price: number;
  fmv: number;
  points: number;
  image: string;
  /** Live MYR market price (display-only) — fmv x FX(USD->MYR) x market_multiplier.
   * Undefined if the FX rate couldn't be resolved (route/backend unreachable). */
  marketPriceMyr?: number;
}

export interface MarketplaceCategory {
  name: string;
  icon: string;
}

// Store API field selection: default fields + card `metadata` + each variant's
// region-resolved `calculated_price` (verified working against the backend).
const PRODUCT_FIELDS = '+metadata,*variants.calculated_price';
const PRODUCT_LIST_LIMIT = 100;

// The store prices cards in MYR (RM), so Store API calls pass the MYR region's id
// to resolve `calculated_price`. The in-flight promise is cached (so concurrent
// callers share one lookup instead of stampeding), but a miss or failure clears
// the cache so the next call retries — region ids are stable.
let storeRegionIdPromise: Promise<string | undefined> | null = null;
function getStoreRegionId(): Promise<string | undefined> {
  if (!storeRegionIdPromise) {
    storeRegionIdPromise = sdk.store.region
      .list()
      .then(({ regions }) => {
        const id = regions.find((r) => r.currency_code === 'myr')?.id;
        if (!id) storeRegionIdPromise = null; // not found — allow a later retry
        return id;
      })
      .catch((error) => {
        storeRegionIdPromise = null; // failed — allow a later retry
        throw error;
      });
  }
  return storeRegionIdPromise;
}

// Storefront port of the backend's displayMarketPrice (packs/pricing.ts) —
// same formula, kept in sync by hand (no cross-package import from the
// storefront into `backend/`). Used only for the marketplace listing price,
// which reads Mercur product data directly rather than a store route that
// could compute this server-side (see products.ts header + GET /store/pricing/fx).
function displayMarketPrice(
  fmvUsd: number,
  fxUsdMyr: number,
  multiplier: number,
): number {
  const raw = Number(fmvUsd);
  const fx = Number(fxUsdMyr);
  const mult = Number(multiplier);
  if (
    ![raw, fx, mult].every(Number.isFinite) ||
    raw < 0 ||
    fx <= 0 ||
    mult <= 0
  )
    return 0;
  return Math.round(raw * fx * mult * 100) / 100;
}

const DEFAULT_USD_MYR = 4.7;

// FX rate for the marketplace listing price, fetched once per request and
// shared across all cards in the grid. Same in-flight-promise caching pattern
// as getStoreRegionId — a miss/failure clears the cache so the next call
// retries. Falls back to DEFAULT_USD_MYR (never blocks the listing on a
// transient backend outage).
let fxRatePromise: Promise<number> | null = null;
function getFxRate(): Promise<number> {
  if (!fxRatePromise) {
    fxRatePromise = sdk.client
      .fetch<{ rate: number }>('/store/pricing/fx')
      .then(({ rate }) =>
        Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_USD_MYR,
      )
      .catch((error) => {
        fxRatePromise = null;
        logger.error(
          '[marketplace] failed to load FX rate from backend:',
          error,
        );
        return DEFAULT_USD_MYR;
      });
  }
  return fxRatePromise;
}

const VALID_RARITIES: readonly Rarity[] = [
  'Legendary',
  'Epic',
  'Rare',
  'Uncommon',
  'Common',
];
const VALID_GRADERS: readonly Grader[] = ['PSA', 'CGC', 'Fanatics'];

const toRarity = (v: unknown): Rarity =>
  (VALID_RARITIES as readonly unknown[]).includes(v) ? (v as Rarity) : 'Common';
const toGrader = (v: unknown): Grader =>
  (VALID_GRADERS as readonly unknown[]).includes(v) ? (v as Grader) : 'CGC';

// Coerce an untrusted `metadata` value to a finite number, else fall back —
// guards against a malformed seed value silently becoming `NaN` in the UI.
const toFinite = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const priceOf = (p: HttpTypes.StoreProduct): number =>
  p.variants?.[0]?.calculated_price?.calculated_amount ?? 0;
const imageOf = (p: HttpTypes.StoreProduct): string =>
  p.thumbnail ?? p.images?.[0]?.url ?? '';

function toMarketplaceCard(
  p: HttpTypes.StoreProduct,
  fxRate: number,
): MarketplaceCard {
  const meta = p.metadata ?? {};
  const price = priceOf(p);
  const fmv = toFinite(meta.fmv, price);
  return {
    id: p.handle,
    title: p.title,
    price,
    fmv,
    points: toFinite(meta.points, 0),
    image: imageOf(p),
    marketPriceMyr: displayMarketPrice(
      fmv,
      fxRate,
      toFinite(meta.market_multiplier, 1.2),
    ),
  };
}

function toMockCard(p: HttpTypes.StoreProduct): MockCard {
  const meta = p.metadata ?? {};
  const price = priceOf(p);
  return {
    id: p.handle,
    name: p.title,
    set: String(meta.set ?? ''),
    grader: toGrader(meta.grader),
    grade: String(meta.grade ?? ''),
    rarity: toRarity(meta.rarity),
    image: imageOf(p),
    fmv: toFinite(meta.fmv, price),
    price,
    points: toFinite(meta.points, 0),
    year: toFinite(meta.year, 0),
  };
}

// Category tabs match the live marketplace (icons localized to
// public/pack-index-icons/). Static this phase: all seeded cards are Pokémon
// and the tab icons are local assets, not backend-derived.
const CATEGORIES: MarketplaceCategory[] = [
  { name: 'Pokémon', icon: '/pack-index-icons/pokemon.webp' },
];

/** Marketplace listing grid — live from the Store API (empty on backend failure). */
export async function getMarketplaceCards(): Promise<MarketplaceCard[]> {
  try {
    const [region_id, fxRate] = await Promise.all([
      getStoreRegionId(),
      getFxRate(),
    ]);
    const { products } = await sdk.store.product.list({
      region_id,
      fields: PRODUCT_FIELDS,
      limit: PRODUCT_LIST_LIMIT,
    });
    return products.map((p) => toMarketplaceCard(p, fxRate));
  } catch (error) {
    logger.error('[marketplace] failed to load products from backend:', error);
    return [];
  }
}

/** Marketplace category tabs. Static this phase (local-asset icons). */
export function getMarketplaceCategories(): MarketplaceCategory[] {
  return CATEGORIES;
}

/**
 * Card detail by handle. Retrieves the seeded product from the Store API and
 * maps it to the card-detail shape; falls back to the deterministic mock pool
 * for any non-seeded slug (so every `/card/<id>` link across the site resolves).
 */
export async function getCardById(handle: string): Promise<MockCard> {
  try {
    const region_id = await getStoreRegionId();
    const { products } = await sdk.store.product.list({
      handle,
      region_id,
      fields: PRODUCT_FIELDS,
      limit: 1,
    });
    const product = products[0];
    if (product) return toMockCard(product);
  } catch (error) {
    logger.error(`[card] failed to load "${handle}" from backend:`, error);
  }
  return cardOrGeneric(handle);
}

/** Seeded product handles for `generateStaticParams` (empty on backend failure). */
export async function getCardHandles(): Promise<string[]> {
  try {
    const { products } = await sdk.store.product.list({
      fields: 'handle',
      limit: PRODUCT_LIST_LIMIT,
    });
    return products.map((p) => p.handle);
  } catch (error) {
    logger.error('[card] failed to load product handles from backend:', error);
    return [];
  }
}
