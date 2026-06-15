/**
 * Gacha pack catalog data seam.
 *
 * Single source for the /claw pack listing. Packs are read live from the custom
 * Medusa route `GET /store/packs` (backend Packs module — see
 * `backend/packages/api/src/modules/packs`). The custom route is publishable-key
 * scoped but bypasses Mercur's seller-visibility product middleware, so packs
 * need no house-seller link to be listed.
 *
 * Resilience: `getPackCategories()` degrades gracefully to the static mock
 * catalog (`src/app/claw/packs-data.ts`) if the backend is unreachable, so the
 * page stays populated and `npm run check` stays green on a backend-down build.
 * The mock catalog also supplies the presentational per-category labels/icons
 * (local assets, not backend-derived).
 */

import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { isRarity, formatValue } from '@/lib/packs-format';
import {
  CATEGORIES as MOCK_CATEGORIES,
  findPack,
  type Pack,
  type PackCategory,
  type PackCard,
  type Rarity,
  type ResolvedPack,
} from '@/app/claw/packs-data';

// Shape of a pack row from GET /store/packs (backend Pack model).
interface BackendPack {
  slug: string;
  title: string;
  category: string;
  price: number;
  image: string;
  boost: boolean;
  rank: number;
  buyback_percent?: number;
  in_stock?: boolean;
}

// Pack prices are whole-dollar USD; render as "$1,000" to match the live site.
const formatPrice = (price: number): string =>
  `$${Math.round(price).toLocaleString('en-US')}`;

const toPack = (p: BackendPack): Pack => ({
  id: p.slug,
  name: p.title,
  price: formatPrice(p.price),
  image: p.image,
  boost: p.boost || undefined,
  buybackPercent:
    typeof p.buyback_percent === 'number' ? p.buyback_percent : undefined,
  inStock: p.in_stock === false ? false : undefined,
});

/**
 * Pack catalog grouped by category, in the live-site category order. Each
 * category's packs come entirely from the backend (ordered by rank); empty
 * categories are dropped. Presentational labels/icons come from the mock
 * catalog. Falls back to the full mock catalog on any backend failure.
 */
export async function getPackCategories(): Promise<PackCategory[]> {
  try {
    const { packs } = await sdk.client.fetch<{ packs: BackendPack[] }>(
      '/store/packs',
    );
    if (!Array.isArray(packs) || packs.length === 0) return MOCK_CATEGORIES;

    // Group backend packs by category key (response is already rank-ordered).
    // Skip malformed rows defensively — the fetch generic is a type assertion,
    // not a runtime guard, so a renamed/absent field can't silently render
    // "$NaN" or a category-less pack.
    const byCategory = new Map<string, Pack[]>();
    for (const p of packs) {
      if (!p || typeof p.category !== 'string' || !Number.isFinite(p.price)) {
        continue;
      }
      const list = byCategory.get(p.category) ?? [];
      list.push(toPack(p));
      byCategory.set(p.category, list);
    }

    // Preserve the live-site category order + presentational meta; keep only
    // categories that actually have backend packs.
    const categories = MOCK_CATEGORIES.map((cat) => ({
      ...cat,
      packs: byCategory.get(cat.id) ?? [],
    }));

    // Keep empty categories so they still render a chip; the client hides empty
    // sections on "All" and shows an empty state when one is selected directly.
    // Fall back to the full mock only if NOTHING resolved.
    return categories.some((c) => c.packs.length > 0)
      ? categories
      : MOCK_CATEGORIES;
  } catch (error) {
    logger.error('[packs] failed to load packs from backend:', error);
    return MOCK_CATEGORIES;
  }
}

export interface PackBase {
  pack: ResolvedPack;
  siblings: Pack[];
}

/**
 * Resolve a single pack + its category siblings by slug from the SAME backend
 * catalog seam as the /claw list (`getPackCategories`). This keeps the detail
 * page in sync with the list: any backend-created pack that shows in the grid
 * also resolves here — fixing the 404 where the detail page used to gate on the
 * static `findPack` 8-pack list while the list rendered live backend packs.
 *
 * `getPackCategories` already degrades to the static mock catalog when the
 * backend is down, so the 8 baked packs still resolve offline. Returns null only
 * when no category contains the slug (genuinely unknown pack → the page 404s).
 */
export async function getPackBySlug(slug: string): Promise<PackBase | null> {
  const categories = await getPackCategories();
  const category = categories.find((c) => c.packs.some((p) => p.id === slug));
  const pack = category?.packs.find((p) => p.id === slug);
  if (!category || !pack) return null;
  return {
    pack: {
      ...pack,
      categoryId: category.id,
      categoryName: category.tab,
      icon: category.icon,
    },
    siblings: category.packs,
  };
}

// --- Pack detail: Top Hits + Pull Odds (GET /store/packs/:slug) -------------

// One joined odds row from the detail route — card display fields ONLY.
//
// 🔒 SECRET ODDS (Phase 6): the per-card `weight` is the real, admin-tuned win
// rate and is NOT exposed by the backend route, so it is absent here by design.
// The customer-facing Pull Odds are a SEPARATE, static published display (the
// `ODDS` constant in packs-data.ts) — never derived from these weights. Only
// non-secret card fields (incl. market_value, which drives Top Hits) arrive.
interface BackendOddsEntry {
  handle: string;
  name: string;
  rarity: string;
  market_value: number;
  image: string;
}

export interface PackDetail {
  topHits: PackCard[];
  /** The full public prize pool (display fields only, weights stay secret) —
   *  feeds the guest demo spin's client-side weighted sample. */
  pool: PackCard[];
}

/**
 * Pack detail for /claw/[slug]: the highest-value cards (Top Hits), derived
 * from the backend prize pool (`GET /store/packs/:slug`). Returns null on any
 * backend failure or empty pool so the detail page falls back to its static
 * mock Top Hits.
 *
 * The customer-facing Pull Odds are intentionally NOT computed here — they are
 * decoupled from the secret per-card weights and rendered from the static
 * published `ODDS` display in packs-data.ts (see PackDetailClient).
 *
 * Phase 5a: every pack draws from one shared card pool, so this detail is
 * pool-wide (identical across packs) — the storefront reuses it when the user
 * switches sibling packs.
 */
export async function getPackDetail(slug: string): Promise<PackDetail | null> {
  try {
    const { odds } = await sdk.client.fetch<{ odds: BackendOddsEntry[] }>(
      `/store/packs/${encodeURIComponent(slug)}`,
    );
    if (!Array.isArray(odds) || odds.length === 0) return null;

    // The fetch generic is a type assertion, not a runtime guard — drop rows
    // with an unknown rarity or non-finite value so the UI can't render NaN.
    const valid = odds.filter(
      (o) =>
        o &&
        typeof o.handle === 'string' &&
        isRarity(o.rarity) &&
        Number.isFinite(o.market_value),
    );
    if (valid.length === 0) return null;

    const pool: PackCard[] = [...valid]
      .sort((a, b) => b.market_value - a.market_value)
      .map((o) => ({
        id: o.handle,
        name: o.name,
        image: o.image,
        value: formatValue(o.market_value),
        rarity: o.rarity as Rarity,
      }));

    return { topHits: pool.slice(0, 5), pool };
  } catch (error) {
    logger.error(`[packs] failed to load pack detail for '${slug}':`, error);
    return null;
  }
}

// --- Recent Pulls: the live ledger feed (GET /store/pulls/recent) -----------

// One row from the public recent-pulls feed (won card + when, no customer PII).
interface BackendRecentPull {
  handle: string;
  name: string;
  image: string;
  market_value: number;
  rarity: string;
  pack_id: string;
  rolled_at: string;
}

export interface RecentPull {
  id: string;
  name: string;
  image: string;
  value: string;
  rarity: Rarity;
  /** Source pack name + icon (for the feed's pack label). */
  packName: string;
  packIcon: string;
  /** Relative timestamp, e.g. "4m ago" (computed at render). */
  agoLabel: string;
}

// Fallback pack label when a pull's pack_id isn't in the static catalog.
const FALLBACK_PACK_ICON = '/images/claw/rookie-pack-icon.webp';

// rolled_at -> "just now" / "4m ago" / "2h ago" / "3d ago".
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return 'just now';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The most recent pulls across all packs, for the /claw/[slug] "Recent Pulls"
 * feed. Returns `[]` (not mock) on any backend failure or empty ledger — an
 * empty feed is a meaningful, truthful state for a live ledger (the component
 * renders a "no pulls yet" empty state), unlike the catalog/detail getters that
 * fall back to mock to keep the page populated.
 */
export async function getRecentPulls(): Promise<RecentPull[]> {
  try {
    const { pulls } = await sdk.client.fetch<{ pulls: BackendRecentPull[] }>(
      '/store/pulls/recent',
    );
    if (!Array.isArray(pulls)) return [];

    return pulls
      .filter(
        (p) =>
          p &&
          typeof p.handle === 'string' &&
          typeof p.name === 'string' &&
          isRarity(p.rarity) &&
          Number.isFinite(p.market_value),
      )
      .map((p, i) => {
        const pack = findPack(p.pack_id);
        return {
          id: `${p.handle}-${p.rolled_at}-${i}`,
          name: p.name,
          image: p.image,
          value: formatValue(p.market_value),
          rarity: p.rarity as Rarity,
          packName: pack?.name ?? 'Mystery Pack',
          packIcon: pack?.image ?? FALLBACK_PACK_ICON,
          agoLabel: relativeTime(p.rolled_at),
        };
      });
  } catch (error) {
    logger.error('[packs] failed to load recent pulls:', error);
    return [];
  }
}
