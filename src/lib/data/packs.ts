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

import { sdk } from "@/lib/medusa";
import { logger } from "@/lib/logger";
import { RARITIES, isRarity, formatValue } from "@/lib/packs-format";
import {
  CATEGORIES as MOCK_CATEGORIES,
  type Pack,
  type PackCategory,
  type PackCard,
  type Rarity,
} from "@/app/claw/packs-data";

// Shape of a pack row from GET /store/packs (backend Pack model).
interface BackendPack {
  slug: string;
  title: string;
  category: string;
  price: number;
  image: string;
  boost: boolean;
  rank: number;
}

// Pack prices are whole-dollar USD; render as "$1,000" to match the live site.
const formatPrice = (price: number): string =>
  `$${Math.round(price).toLocaleString("en-US")}`;

const toPack = (p: BackendPack): Pack => ({
  id: p.slug,
  name: p.title,
  price: formatPrice(p.price),
  image: p.image,
  boost: p.boost || undefined,
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
      "/store/packs",
    );
    if (!Array.isArray(packs) || packs.length === 0) return MOCK_CATEGORIES;

    // Group backend packs by category key (response is already rank-ordered).
    // Skip malformed rows defensively — the fetch generic is a type assertion,
    // not a runtime guard, so a renamed/absent field can't silently render
    // "$NaN" or a category-less pack.
    const byCategory = new Map<string, Pack[]>();
    for (const p of packs) {
      if (!p || typeof p.category !== "string" || !Number.isFinite(p.price)) {
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
    })).filter((cat) => cat.packs.length > 0);

    return categories.length ? categories : MOCK_CATEGORIES;
  } catch (error) {
    logger.error("[packs] failed to load packs from backend:", error);
    return MOCK_CATEGORIES;
  }
}

// --- Pack detail: Top Hits + Pull Odds (GET /store/packs/:slug) -------------

// One joined odds row from the detail route (card display fields + its weight).
interface BackendOddsEntry {
  handle: string;
  name: string;
  rarity: string;
  market_value: number;
  image: string;
  weight: number;
}

export interface RarityOdd {
  rarity: Rarity;
  chance: string;
  dot: string;
}

export interface PackDetail {
  topHits: PackCard[];
  rarityOdds: RarityOdd[];
}

// Rarest-first dot colors (presentational). The rarest-first ORDER (RARITIES),
// the isRarity guard, and formatValue come from the shared packs-format module.
const RARITY_DOT: Record<Rarity, string> = {
  Legendary: "bg-amber-400",
  Epic: "bg-fuchsia-400",
  Rare: "bg-sky-400",
  Uncommon: "bg-emerald-400",
  Common: "bg-neutral-400",
};

// Pull chance -> "8.9%" / "30%" (drop a trailing ".0", matching the mock odds).
const formatChance = (pct: number): string => {
  const s = pct.toFixed(1);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s}%`;
};

/**
 * Pack detail for /claw/[slug]: the highest-value cards (Top Hits) and the
 * pull-chance-by-rarity table, both derived from the backend gacha odds
 * (`GET /store/packs/:slug`). Returns null on any backend failure or empty
 * odds so the detail page falls back to its static mock pools.
 *
 * Phase 5a: every pack draws from one shared card pool, so this detail is
 * pool-wide (identical across packs) — the storefront reuses it when the user
 * switches sibling packs. Per-pack pools + live Recent Pulls arrive in 5b.
 */
export async function getPackDetail(slug: string): Promise<PackDetail | null> {
  try {
    const { odds } = await sdk.client.fetch<{ odds: BackendOddsEntry[] }>(
      `/store/packs/${encodeURIComponent(slug)}`,
    );
    if (!Array.isArray(odds) || odds.length === 0) return null;

    // The fetch generic is a type assertion, not a runtime guard — drop rows
    // with an unknown rarity or non-finite numbers so the UI can't render NaN.
    const valid = odds.filter(
      (o) =>
        o &&
        typeof o.handle === "string" &&
        isRarity(o.rarity) &&
        Number.isFinite(o.market_value) &&
        Number.isFinite(o.weight),
    );
    if (valid.length === 0) return null;

    const topHits: PackCard[] = [...valid]
      .sort((a, b) => b.market_value - a.market_value)
      .slice(0, 5)
      .map((o) => ({
        id: o.handle,
        name: o.name,
        image: o.image,
        value: formatValue(o.market_value),
        rarity: o.rarity as Rarity,
      }));

    // Aggregate weight per rarity -> chance % = Σweight(rarity) / Σweight(all).
    const total = valid.reduce((sum, o) => sum + o.weight, 0);
    const weightByRarity = new Map<Rarity, number>();
    for (const o of valid) {
      const r = o.rarity as Rarity;
      weightByRarity.set(r, (weightByRarity.get(r) ?? 0) + o.weight);
    }
    const rarityOdds: RarityOdd[] = RARITIES.filter((r) =>
      weightByRarity.has(r),
    ).map((r) => ({
      rarity: r,
      chance:
        total > 0
          ? formatChance((weightByRarity.get(r)! / total) * 100)
          : "0%",
      dot: RARITY_DOT[r],
    }));

    return { topHits, rarityOdds };
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
  rolled_at: string;
}

export interface RecentPull {
  id: string;
  name: string;
  image: string;
  value: string;
  rarity: Rarity;
  /** Relative timestamp, e.g. "4m ago" (computed at render). */
  agoLabel: string;
}

// rolled_at -> "just now" / "4m ago" / "2h ago" / "3d ago".
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "just now";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
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
      "/store/pulls/recent"
    );
    if (!Array.isArray(pulls)) return [];

    return pulls
      .filter(
        (p) =>
          p &&
          typeof p.handle === "string" &&
          typeof p.name === "string" &&
          isRarity(p.rarity) &&
          Number.isFinite(p.market_value)
      )
      .map((p, i) => ({
        id: `${p.handle}-${p.rolled_at}-${i}`,
        name: p.name,
        image: p.image,
        value: formatValue(p.market_value),
        rarity: p.rarity as Rarity,
        agoLabel: relativeTime(p.rolled_at),
      }));
  } catch (error) {
    logger.error("[packs] failed to load recent pulls:", error);
    return [];
  }
}
