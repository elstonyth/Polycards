/**
 * Gacha pack catalog data seam.
 *
 * Single source for the /claw pack listing. Packs are read live from the custom
 * Medusa route `GET /store/packs` (backend Packs module — see
 * `backend/packages/api/src/modules/packs`). The custom route is publishable-key
 * scoped but bypasses Mercur's seller-visibility product middleware, so packs
 * need no house-seller link to be listed.
 *
 * The backend is the single source of truth: zero backend packs (or an
 * unreachable backend) ⇒ zero storefront packs — the pages render their empty
 * states instead of a mock catalog. The local catalog (`src/lib/packs-data.ts`)
 * only supplies the presentational per-category labels/icons (local assets).
 */

import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { formatValue, isRarity, type PublishedOdds } from '@/lib/packs-format';
import { money, relativeTime } from '@/lib/format';
import {
  parseList,
  PackRowSchema,
  OddsEntrySchema,
  RecentPullSchema,
} from '@/lib/data/schemas';
import {
  CATEGORIES as CATEGORY_META,
  CAT_ICON,
  type Pack,
  type PackCategory,
  type PackCard,
  type Rarity,
  type ResolvedPack,
} from '@/lib/packs-data';

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

// Pack prices are in RM; render as "RM 1,000".
const formatPrice = (price: number): string =>
  money(Math.round(price), { decimals: 0, prefix: 'RM ' });

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

/** 'one-piece' → 'One Piece' — label for a category key the local meta lacks. */
const titleCase = (key: string): string =>
  key
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Pack catalog grouped by category, in the live-site category order. The packs
 * come entirely from the backend (ordered by rank) — the backend is the single
 * source of truth, so zero backend packs (or an unreachable backend) yields
 * empty categories and the pages render their empty states. Presentational
 * labels/icons come from the local category meta.
 */
export async function getPackCategories(): Promise<PackCategory[]> {
  try {
    const { packs } = await sdk.client.fetch<{ packs: BackendPack[] }>(
      '/store/packs',
    );

    // Group backend packs by category key (response is already rank-ordered).
    // Skip malformed rows defensively — the fetch generic is a type assertion,
    // not a runtime guard, so a renamed/absent field can't silently render
    // "$NaN" or a category-less pack.
    const byCategory = new Map<string, Pack[]>();
    for (const p of parseList(
      PackRowSchema,
      Array.isArray(packs) ? packs : [],
    ) as unknown as BackendPack[]) {
      const list = byCategory.get(p.category) ?? [];
      list.push(toPack(p));
      byCategory.set(p.category, list);
    }

    // Known categories keep the live-site order + presentational meta (empty
    // ones still render a chip; the client shows empty states). A backend pack
    // in a category the local meta doesn't know still renders — title-cased
    // label + fallback icon — instead of silently disappearing.
    const known = CATEGORY_META.map((cat) => ({
      ...cat,
      packs: byCategory.get(cat.id) ?? [],
    }));
    const knownIds = new Set(known.map((c) => c.id));
    const extras = [...byCategory.entries()]
      .filter(([id]) => !knownIds.has(id))
      .map(([id, list]) => ({
        id,
        tab: titleCase(id),
        heading: `${titleCase(id)} Packs`,
        icon: CAT_ICON.pokemon,
        packs: list,
      }));
    return [...known, ...extras];
  } catch (error) {
    logger.error('[packs] failed to load packs from backend:', error);
    // Backend unreachable — truthfully show no packs rather than a mock set.
    return CATEGORY_META.map((cat) => ({ ...cat, packs: [] }));
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
 * Returns null when no category contains the slug — unknown pack, or the
 * backend is down/empty (source of truth) → the page 404s.
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
// 🔒 SECRET ODDS: the per-card `weight` is the real, admin-tuned win rate and
// is NOT exposed by the backend route, so it is absent here by design. The
// customer-facing Pull Odds are the SEPARATE, admin-PUBLISHED `published_odds`
// on the pack (see PackDetail.publishedOdds) — never derived from these
// weights. Only non-secret card fields (incl. market_value → Top Hits) arrive.
interface BackendOddsEntry {
  handle: string;
  name: string;
  rarity: string;
  market_value: number;
  /** Live MYR display price (FMV × FX × margin) computed by the backend at
   *  request time; absent on an older backend → fall back to market_value. */
  marketPriceMyr?: number;
  image: string;
  /** Admin-picked Top Hit flag (display only). */
  top_hit?: boolean;
}

export interface PackDetail {
  topHits: PackCard[];
  /** The full public prize pool (display fields only, weights stay secret) —
   *  feeds the guest demo spin's client-side weighted sample. */
  pool: PackCard[];
  /** Admin-published PUBLIC odds; null = not set (the odds panel is hidden). */
  publishedOdds: PublishedOdds | null;
}

// Sanitize the backend's published_odds json (jsonb passthrough — validate at
// the trust boundary so a malformed value can't render NaN or unknown tiers).
const parsePublishedOdds = (raw: unknown): PublishedOdds | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as { overall?: unknown; tiers?: unknown };
  const okPct = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
  if (!okPct(o.overall)) return null;
  const tiers: PublishedOdds['tiers'] = {};
  if (o.tiers && typeof o.tiers === 'object' && !Array.isArray(o.tiers)) {
    for (const [k, v] of Object.entries(o.tiers as Record<string, unknown>)) {
      if (isRarity(k) && okPct(v)) tiers[k] = v;
    }
  }
  return { overall: o.overall, tiers };
};

/**
 * Pack detail for /claw/[slug]: the highest-value cards (Top Hits), derived
 * from the backend prize pool (`GET /store/packs/:slug`). Returns null on any
 * backend failure or empty pool so the detail page renders its empty gacha
 * state (the backend is the source of truth — no mock fallback).
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
    const { odds, published_odds } = await sdk.client.fetch<{
      odds: BackendOddsEntry[];
      published_odds?: unknown;
    }>(`/store/packs/${encodeURIComponent(slug)}`);
    if (!Array.isArray(odds) || odds.length === 0) return null;

    // The fetch generic is a type assertion, not a runtime guard — drop rows
    // with an unknown rarity or non-finite value so the UI can't render NaN.
    const valid = parseList(
      OddsEntrySchema,
      odds,
    ) as unknown as BackendOddsEntry[];
    if (valid.length === 0) return null;

    const toCard = (o: BackendOddsEntry): PackCard => ({
      id: o.handle,
      name: o.name,
      image: o.image,
      value: formatValue(o.marketPriceMyr ?? o.market_value),
      rarity: o.rarity as Rarity,
    });
    const sorted = [...valid].sort(
      (a, b) =>
        (b.marketPriceMyr ?? b.market_value) -
        (a.marketPriceMyr ?? a.market_value),
    );
    const pool: PackCard[] = sorted.map(toCard);

    // Top Hits = the admin-flagged cards (value-sorted). No flags on this
    // pack → fall back to the five highest-value cards.
    const flagged = sorted.filter((o) => o.top_hit === true);
    const topHits = flagged.length > 0 ? flagged.map(toCard) : pool.slice(0, 5);

    return {
      topHits,
      pool,
      publishedOdds: parsePublishedOdds(published_odds),
    };
  } catch (error) {
    logger.error(`[packs] failed to load pack detail for '${slug}':`, error);
    return null;
  }
}

// --- Recent Pulls: the live ledger feed (GET /store/pulls/recent) -----------

// One row from the public recent-pulls feed: won card + when + the source
// pack's live catalog label + a MASKED puller name ("Els***" / "Anonymous").
interface BackendRecentPull {
  handle: string;
  name: string;
  image: string;
  market_value: number;
  /** Live MYR display price — same optional contract as BackendOddsEntry. */
  marketPriceMyr?: number;
  rarity: string;
  pack_id: string;
  /** Pack label from the live catalog; null when the pack was deleted. */
  pack_title?: string | null;
  pack_image?: string | null;
  /** Masked puller display name; absent on an older backend. */
  who?: string;
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
  /** Masked puller display name, e.g. "Els***" (never full identity). */
  who: string;
  /** Relative timestamp, e.g. "4m ago" (computed at render). */
  agoLabel: string;
}

// Fallback pack label when a pull's pack_id isn't in the static catalog.
const FALLBACK_PACK_ICON = '/images/claw/rookie-pack-icon.webp';

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

    return (
      parseList(RecentPullSchema, pulls) as unknown as BackendRecentPull[]
    ).map((p, i) => ({
      id: `${p.handle}-${p.rolled_at}-${i}`,
      name: p.name,
      image: p.image,
      value: formatValue(p.marketPriceMyr ?? p.market_value),
      rarity: p.rarity as Rarity,
      // Pack label straight from the backend catalog (source of truth) — a
      // since-deleted pack degrades to the neutral label, never a wrong one.
      packName: p.pack_title ?? 'Mystery Pack',
      packIcon: p.pack_image ?? FALLBACK_PACK_ICON,
      who: p.who ?? 'Anonymous',
      agoLabel: relativeTime(p.rolled_at),
    }));
  } catch (error) {
    logger.error('[packs] failed to load recent pulls:', error);
    return [];
  }
}
