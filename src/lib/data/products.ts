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
}

export interface MarketplaceCategory {
  name: string;
  icon: string;
}

// Store API field selection: default fields + card `metadata` + each variant's
// region-resolved `calculated_price` (verified working against the backend).
const PRODUCT_FIELDS = '+metadata,*variants.calculated_price';
const PRODUCT_LIST_LIMIT = 100;

// The storefront prices and displays cards in USD, so Store API calls pass the
// USD region's id to resolve `calculated_price`. The in-flight promise is cached
// (so concurrent callers share one lookup instead of stampeding), but a miss or
// failure clears the cache so the next call retries — region ids are stable.
let usdRegionIdPromise: Promise<string | undefined> | null = null;
function getUsdRegionId(): Promise<string | undefined> {
  if (!usdRegionIdPromise) {
    usdRegionIdPromise = sdk.store.region
      .list()
      .then(({ regions }) => {
        const id = regions.find((r) => r.currency_code === 'usd')?.id;
        if (!id) usdRegionIdPromise = null; // not found — allow a later retry
        return id;
      })
      .catch((error) => {
        usdRegionIdPromise = null; // failed — allow a later retry
        throw error;
      });
  }
  return usdRegionIdPromise;
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

function toMarketplaceCard(p: HttpTypes.StoreProduct): MarketplaceCard {
  const meta = p.metadata ?? {};
  const price = priceOf(p);
  return {
    id: p.handle,
    title: p.title,
    price,
    fmv: toFinite(meta.fmv, price),
    points: toFinite(meta.points, 0),
    image: imageOf(p),
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
    const region_id = await getUsdRegionId();
    const { products } = await sdk.store.product.list({
      region_id,
      fields: PRODUCT_FIELDS,
      limit: PRODUCT_LIST_LIMIT,
    });
    return products.map(toMarketplaceCard);
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
    const region_id = await getUsdRegionId();
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
