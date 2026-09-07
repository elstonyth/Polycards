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

import { unstable_cache } from 'next/cache';
import { cached } from '@/lib/ttl-cache';
import { store } from '@/lib/store';
import { logger } from '@/lib/logger';
import { isRarity, type PublishedOdds } from '@/lib/packs-format';
import { avatarForSeed } from '@/lib/profile-view';
import { relativeTime } from '@/lib/format';
import { toCardView, type CardView } from '@/lib/card-view';
import {
  PacksPageSchema,
  UncatalogedPackSchema,
  PackDetailPageSchema,
  RecentPullsPageSchema,
  PullGapsSchema,
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

// Every route in this file is PUBLIC, and both halves of this matter: no
// bearer, and `cache: 'auto'` — no cache key on the wire, which is what the
// bare sdk.client.fetch calls sent. An explicit `no-store` would make a
// statically prerenderable route dynamic, and src/app/page.tsx renders this
// catalog, this feed and (via getPackChase) this detail under `revalidate = 15`.
const PUBLIC = { auth: 'none', cache: 'auto' } as const;

// Shape of a pack row from GET /store/packs (backend Pack model).
interface BackendPack {
  slug: string;
  title: string;
  category: string;
  price: number;
  image: string;
  display_image?: string | null;
  boost: boolean;
  rank: number;
  buyback_percent?: number;
  in_stock?: boolean;
  group?: 'GRADED' | 'RAW' | 'MIX' | null;
  psa10?: boolean;
}

const toPack = (p: BackendPack): Pack => ({
  id: p.slug,
  name: p.title,
  priceMyr: p.price,
  image: p.image,
  displayImage: p.display_image || undefined,
  boost: p.boost || undefined,
  buybackPercent:
    typeof p.buyback_percent === 'number' ? p.buyback_percent : undefined,
  inStock: p.in_stock === false ? false : undefined,
  // Schema-validated (unknown values already degraded to null/false) —
  // passthrough. psa10 defaults false: never overclaim the guarantee.
  group: p.group ?? null,
  psa10: p.psa10 === true,
});

/** 'one-piece' → 'One Piece' — label for a category key the local meta lacks.
 *  Underscores split too, so the reserved 'free_welcome' key reads as a label
 *  rather than 'Free_welcome'. */
const titleCase = (key: string): string =>
  key
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/**
 * Pack catalog grouped by category, in the live-site category order. The packs
 * come entirely from the backend (ordered by rank) — the backend is the single
 * source of truth, so zero backend packs (or an unreachable backend) yields
 * empty categories and the pages render their empty states. Presentational
 * labels/icons come from the local category meta.
 */
async function loadPackCategories(): Promise<PackCategory[]> {
  // orThrow, and PacksPageSchema rejects a non-array `packs`: that is a
  // malformed 200 (deploy skew, proxy error page, schema rename), not a
  // legitimately empty catalog, and it must reject so the TTL memo evicts
  // instead of caching an all-empty catalog for the window. Malformed ROWS
  // still drop one at a time, so a renamed field on one pack can't render
  // "$NaN" or a category-less pack — and can't blank the rest either.
  const { packs } = store.orThrow(
    await store.get('/store/packs', PacksPageSchema, PUBLIC),
  );

  // Group backend packs by category key (response is already rank-ordered).
  const byCategory = new Map<string, Pack[]>();
  for (const p of packs as unknown as BackendPack[]) {
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
}

// Matches the backend's own 30s window on GET /store/packs. The catalog is the
// same for every visitor, but /slots and /leaderboard read auth cookies, so
// those pages can never be statically rendered — without this every request
// re-pays the backend hop and the zod parse for a body the backend is already
// serving from cache.
const CATALOG_TTL_MS = 30_000;

/**
 * Pack catalog, memoised per process for one backend cache window.
 *
 * The degradation is caught HERE, outside `cached`, and loadPackCategories is
 * left to throw. Catching inside the loader would make a transient backend
 * failure resolve to an empty catalog, which `cached` cannot tell from a real
 * one — so one blip would blank /slots for the full 30s window instead of for
 * the blip. Rejecting lets `cached` evict, and the next request retries.
 */
export async function getPackCategories(): Promise<PackCategory[]> {
  try {
    return await cached('pack-categories', CATALOG_TTL_MS, loadPackCategories);
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
 * catalog seam as the /slots list (`getPackCategories`). This keeps the detail
 * page in sync with the list: any backend-created pack that shows in the grid
 * also resolves here — fixing the 404 where the detail page used to gate on a
 * static pack table (since deleted) while the list rendered live backend packs.
 *
 * Returns null when no category contains the slug — unknown pack, or the
 * backend is down/empty (source of truth) → the page 404s.
 */
export async function getPackBySlug(slug: string): Promise<PackBase | null> {
  const categories = await getPackCategories();
  const category = categories.find((c) => c.packs.some((p) => p.id === slug));
  const pack = category?.packs.find((p) => p.id === slug);
  if (!category || !pack) return getUncatalogedPack(slug);
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

/**
 * A pack that is REACHABLE but not LISTED — resolved from the detail route
 * (`GET /store/packs/:slug`) instead of the catalog list.
 *
 * The free welcome pack lives in the reserved `free_welcome` category, which
 * `GET /store/packs` filters out (it is reached only through its own claim
 * badge), so the catalog lookup above can never find it and every /slots/<slug>
 * surface would 404. The detail route only hides `reward_box`, so it answers
 * here — which also keeps internal draw pools hidden (it 404s them) without a
 * second exclusion list to drift.
 *
 * `siblings` is empty by construction: an unlisted pack has no catalog row to
 * sit beside, and the detail page hides its pack selector when the list is
 * empty. Returns null on 404 / any failure — the page then 404s as before.
 */
async function getUncatalogedPack(slug: string): Promise<PackBase | null> {
  // UncatalogedPackSchema applies the same runtime guard the list path does
  // (category + finite price) to the single row, so a 404, an outage and a
  // 200 with no usable pack all answer null — as before. The port logged it,
  // with the slug in the path it names.
  const r = await store.get(
    `/store/packs/${encodeURIComponent(slug)}`,
    UncatalogedPackSchema,
    PUBLIC,
  );
  if (!r.ok) return null;
  const pack = r.data.pack as unknown as BackendPack;
  const meta = CATEGORY_META.find((c) => c.id === pack.category);
  return {
    pack: {
      ...toPack(pack),
      categoryId: pack.category,
      categoryName: meta?.tab ?? titleCase(pack.category),
      icon: meta?.icon ?? CAT_ICON.pokemon,
    },
    siblings: [],
  };
}

// --- Pack detail: Top Hits + Pull Odds (GET /store/packs/:slug) -------------

// One joined odds row from the detail route — the wire card (CardWireSchema
// reads the display fields; `toCardView` maps them) plus the row's own fields.
//
// 🔒 SECRET ODDS: the per-card `weight` is the real, admin-tuned win rate and
// is NOT exposed by the backend route, so it is absent here by design. The
// customer-facing Pull Odds are the SEPARATE, admin-PUBLISHED `published_odds`
// on the pack (see PackDetail.publishedOdds) — never derived from these
// weights. Only non-secret card fields (incl. market_value → Top Hits) arrive.
interface BackendOddsEntry {
  /** Guaranteed by OddsEntrySchema — a row without a known tier drops. */
  rarity: Rarity;
  /** Raw USD FMV — kept for SORTING only (Top Hits/pool order); never format
   *  it directly as RM (it isn't MYR). Display prefers marketPriceMyr. */
  market_value: number;
  /** Live MYR display price (FMV × FX × margin) computed by the backend at
   *  request time; absent on an older backend → the card renders "—" instead
   *  of the raw USD number behind an "RM" prefix. */
  marketPriceMyr?: number;
  /** Admin-picked Top Hit display order (1-based; null/absent = not one). */
  top_hit_order?: number | null;
}

export interface PackDetail {
  topHits: PackCard[];
  /** The full public prize pool (display fields only, weights stay secret) —
   *  feeds the guest demo spin's client-side weighted sample. */
  pool: PackCard[];
  /** Admin-published PUBLIC odds; null = not set (the odds panel is hidden). */
  publishedOdds: PublishedOdds | null;
  /** Odds SET 3's real tier split, backend-aggregated — what the guest demo
   *  spin samples on (never shown as the odds panel, never used by a real
   *  spin). Null on an older backend / an unpullable pool → the demo falls
   *  back to the published odds. */
  demoOdds: PublishedOdds | null;
}

// Sanitize the backend's published_odds json (jsonb passthrough — validate at
// the trust boundary so a malformed value can't render NaN or unknown tiers).
const parsePublishedOdds = (raw: unknown): PublishedOdds | null => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as { tiers?: unknown };
  const okPct = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100;
  const tiers: PublishedOdds['tiers'] = {};
  if (o.tiers && typeof o.tiers === 'object' && !Array.isArray(o.tiers)) {
    for (const [k, v] of Object.entries(o.tiers as Record<string, unknown>)) {
      if (isRarity(k) && okPct(v)) tiers[k] = v;
    }
  }
  return { tiers };
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
 */
export async function getPackDetail(slug: string): Promise<PackDetail | null> {
  // Every no-pool answer is the same null the page's empty gacha state reads:
  // a 404, an outage, a non-array `odds`, an empty pool, or a pool whose rows
  // all failed the schema (unknown rarity / non-finite value — dropped so the
  // UI can't render NaN).
  const r = await store.get(
    `/store/packs/${encodeURIComponent(slug)}`,
    PackDetailPageSchema,
    PUBLIC,
  );
  if (!r.ok) return null;
  const { published_odds, demo_odds } = r.data;
  const valid = r.data.odds as unknown as BackendOddsEntry[];
  if (valid.length === 0) return null;

  // The tier is re-stated from the schema-guaranteed row so PackCard's
  // required `rarity: Rarity` holds; the view itself maps through toCardView.
  const toCard = (o: BackendOddsEntry): PackCard => ({
    ...toCardView(o),
    rarity: o.rarity,
  });
  const sorted = [...valid].sort(
    (a, b) =>
      (b.marketPriceMyr ?? b.market_value) -
      (a.marketPriceMyr ?? a.market_value),
  );
  const pool: PackCard[] = sorted.map(toCard);

  // Top Hits = the admin-ordered cards (order 1 renders first/leftmost).
  // No ordered cards on this pack → EMPTY (the page hides the section);
  // the old highest-value fallback made un-curated packs look curated.
  const topHits = valid
    .filter((o) => o.top_hit_order != null)
    .sort((a, b) => (a.top_hit_order ?? 0) - (b.top_hit_order ?? 0))
    .map(toCard);

  return {
    topHits,
    pool,
    publishedOdds: parsePublishedOdds(published_odds),
    // Same { tiers } shape from the backend, so the same sanitizer applies.
    demoOdds: parsePublishedOdds(demo_odds),
  };
}

/**
 * A pack's top chase card — the single field the home shelf needs off a pack.
 *
 * Cached because the home page is `force-dynamic` and the only source for this
 * one card is the whole prize pool: `/store/packs/bronze-pack` alone is ~288 KB
 * and the five live packs total ~700 KB, all of it fetched, zod-parsed and then
 * discarded on EVERY home render, on a 1-vCPU box. Measured 2026-08-17 against
 * a production build: a cold render issues five /store/packs/<slug> requests,
 * the next three inside the TTL issue none.
 *
 * Cached HERE rather than around getPackDetail: the derived card is a few
 * hundred bytes where the detail is hundreds of KB, so the entry stays cheap to
 * hold, and `/slots/[slug]` — which genuinely renders the whole pool and its
 * odds — keeps reading through uncached.
 *
 * 60 s because pools change on a catalog edit, not per request; no `tags`
 * because nothing in the storefront calls `revalidateTag` today, and an
 * invalidation hook nobody fires is worse than none.
 *
 * NOTE the failure path this buys: getPackDetail returns null on a backend
 * error, and a cache stores whatever it is given, so a blip during a COLD miss
 * pins "no chase" on that pack for the full TTL where it used to self-heal on
 * the next request. Only a cold miss — once an entry exists, expiry serves the
 * stale value and revalidates behind the request, and a failed revalidate keeps
 * the stale value rather than overwriting it with null.
 *
 * Not fixed by throwing on null to keep failures out of the cache, and NOT
 * because a throw would break the render (it would not — the callback is
 * awaited before the write, so a rejection is never cached, and a wrapper's
 * catch absorbs it). Because getPackDetail returns null for TWO things: a
 * backend error, and a pool that is legitimately empty or all-invalid (see its
 * early returns). Throwing would make every empty-pool pack refetch its whole
 * payload on every home render, forever — reinstating exactly the cost this
 * exists to remove.
 *
 * Read the degradation as the hero, not a footnote: a null chase on the
 * FEATURED pack drops HeroBoard to its no-prize headline ("Rip real graded
 * cards"), losing the Chase Gold value and its bloom, for up to a TTL. Still
 * graceful, still the cheaper failure than a dead render.
 *
 * `unstable_cache` rather than `use cache`: the latter needs
 * `cacheComponents: true`, a whole-app rendering-semantics opt-in, for one hot
 * path. Migrate together, not here.
 */
export const getPackChase = unstable_cache(
  async (slug: string): Promise<PackCard | null> => {
    const detail = await getPackDetail(slug);
    // pool is value-sorted desc, so the first PRICED entry is the pack's
    // highest-value card (null = an older backend omitted marketPriceMyr;
    // falling through it keeps a fake headline off the shelf).
    return detail?.pool.find((c) => c.priceMyr !== null) ?? null;
  },
  ['pack-chase'],
  { revalidate: 60 },
);

// --- Recent Pulls: the live ledger feed (GET /store/pulls/recent) -----------

// One row from the public recent-pulls feed: the won card (wire fields, read
// by toCardView) + when + the source pack's live catalog label + the puller's
// display name ("Anonymous" when the account has none).
interface BackendRecentPull {
  /** Guaranteed by RecentPullSchema — a row without one drops. */
  handle: string;
  /** Guaranteed by RecentPullSchema — a row without a known tier drops. */
  rarity: Rarity;
  pack_id: string;
  /** Pack label from the live catalog; null when the pack was deleted. */
  pack_title?: string | null;
  pack_image?: string | null;
  /** Puller display name (first_name, full); absent on an older backend. */
  who?: string;
  rolled_at: string;
  /** Pull row id — the feed's stable key; absent on an older backend. */
  id?: string;
  /** The leaderboard's PII-safe display fields (see publicProfileFields). */
  seed?: number;
  profile_handle?: string | null;
  avatar_url?: string | null;
  /** Equipped milestone frame, resolved backend-side. */
  frame_url?: string | null;
}

/** A feed row: the won card (its `handle` opens the card-detail overlay;
 *  `priceMyr` null = an older backend omitted the MYR price — rows render
 *  '—') plus the pull's own display fields. */
export type RecentPull = CardView & {
  id: string;
  /** Always known: the feed schema drops a row without a tier. */
  rarity: Rarity;
  /** Source pack name + icon (for the feed's pack label). */
  packName: string;
  packIcon: string;
  /** Puller display name (first_name in full — never email/id). */
  who: string;
  /** Puller's public profile handle — the avatar links to /profile/<handle>.
   *  null = no public profile (anonymised row, or a customer without one):
   *  the avatar then renders unlinked. */
  profileHandle: string | null;
  /** Puller avatar — uploaded photo, else the seed-derived pfp; null = the
   *  initial-letter fallback (the reel's own "You" rows). */
  avatar: string | null;
  /** Equipped milestone frame overlay; null = none. */
  frame: string | null;
  /** ISO roll time — the absolute timestamp the history rows print. */
  rolledAt: string;
  /** Relative timestamp, e.g. "4m ago" (computed at render). */
  agoLabel: string;
};

/** The pull-history feed: rows + the drought counters ("N packs without
 *  Immortal" — pulls since that tier last hit, in the same pack scope). The
 *  backend chooses which tiers it counts; the panel renders whatever arrives. */
export interface RecentFeed {
  pulls: RecentPull[];
  drought: Partial<Record<Rarity, number>>;
}

const EMPTY_FEED: RecentFeed = { pulls: [], drought: {} };

// Fallback pack label when a pull's pack_id isn't in the static catalog.
const FALLBACK_PACK_ICON = '/images/polycards/bronze-pack.webp';

/**
 * The pull-history feed — across all packs, or, with `packSlug`, only that
 * pack's own history (the /slots/[slug] pages; filtering backend-side, so a
 * quiet pack still shows its real history instead of nothing). `rarity` keeps
 * only that tier's pulls (the panel's tier tabs; the drought counters stay
 * unfiltered).
 * Returns an empty feed (not mock) on any backend failure or empty ledger — an
 * empty feed is a meaningful, truthful state for a live ledger (the component
 * renders a "no pulls yet" empty state), unlike the catalog/detail getters that
 * fall back to mock to keep the page populated.
 */
export async function getRecentPulls(
  packSlug?: string,
  rarity?: Rarity,
): Promise<RecentFeed> {
  // Same two params, same order (`?pack_id=…&rarity=…`) — the SDK
  // serializes this object to the querystring the path carried before, and
  // an absent pair omits the key entirely rather than sending a bare "?".
  const query = {
    ...(packSlug ? { pack_id: packSlug } : {}),
    ...(rarity ? { rarity } : {}),
  };
  const r = await store.get('/store/pulls/recent', RecentPullsPageSchema, {
    ...PUBLIC,
    ...(Object.keys(query).length > 0 ? { query } : {}),
  });
  // An empty feed is a truthful state for a live ledger, and so is the
  // answer to a failure or a non-array `pulls` — the component renders "no
  // pulls yet" either way, and never mock rows.
  if (!r.ok) return EMPTY_FEED;
  const raw = r.data;

  // Stable ids: the pull row id, else (older backend) a per-(handle,
  // rolled_at) occurrence counter — NOT the array index, which shifts
  // whenever the poll prepends a new pull, remounting every feed row (and
  // replaying entry animations) instead of just adding one.
  const seen = new Map<string, number>();
  const pulls: RecentPull[] = (raw.pulls as unknown as BackendRecentPull[]).map(
    (p) => {
      const key = `${p.handle}-${p.rolled_at}`;
      const n = seen.get(key) ?? 0;
      seen.set(key, n + 1);
      return {
        ...toCardView(p),
        id: p.id ?? `${key}-${n}`,
        rarity: p.rarity,
        // Pack label straight from the backend catalog (source of truth) — a
        // since-deleted pack degrades to the neutral label, never a wrong one.
        packName: p.pack_title ?? 'Mystery Pack',
        packIcon: p.pack_image ?? FALLBACK_PACK_ICON,
        who: p.who ?? 'Anonymous',
        profileHandle: p.profile_handle ?? null,
        // The same seed → pfp mapping as the leaderboard / public profile.
        avatar: p.avatar_url ?? (p.seed != null ? avatarForSeed(p.seed) : null),
        frame: p.frame_url ?? null,
        rolledAt: p.rolled_at,
        agoLabel: relativeTime(p.rolled_at),
      };
    },
  );
  // Trust boundary: only known tiers with a finite non-negative count.
  const drought: RecentFeed['drought'] = {};
  if (raw.drought && typeof raw.drought === 'object') {
    for (const [k, v] of Object.entries(raw.drought)) {
      if (isRarity(k) && typeof v === 'number' && Number.isFinite(v) && v >= 0)
        drought[k] = v;
    }
  }
  return { pulls, drought };
}

/**
 * The pack scope a public feed proxy (/api/recent-pulls, /api/pull-gaps) may
 * cache under: the given slug when it is a real, reachable pack, else '' (the
 * global feed). Cache keys must be bounded to the real catalog, not just
 * kebab-shaped — an unbounded valid-shaped namespace still fills the TTL Map
 * and evicts the hot keys. getPackCategories is already cached (same 30s
 * window), so this adds no backend hop for a catalog slug.
 *
 * One pack is reachable but never LISTED: the free welcome pack (GET
 * /store/packs filters free_welcome out — see getUncatalogedPack). A catalog
 * miss therefore falls through to the detail route before the slug is
 * discarded, or that pack's spin page would flip to the global feed on its
 * first poll. Garbage slugs still mint no key: the shape gate runs first (a
 * public endpoint must not pay a backend round-trip, and an error log, per
 * garbage request), and the detail route 404s the rest.
 */
export async function resolveFeedPackSlug(
  raw: string | null | undefined,
): Promise<string> {
  const slug = raw?.trim() ?? '';
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return '';
  const cats = await getPackCategories();
  const known = cats.some((c) => c.packs.some((p) => p.id === slug));
  return known || (await getPackBySlug(slug)) !== null ? slug : '';
}

// --- Pull gaps: the stats chart (GET /store/pulls/gaps) ---------------------

/** One hit of the tier on the chart: how many pulls it took since the
 *  previous hit, and who landed it (the feed's display fields). */
export interface PullGapHit {
  id: string;
  gap: number;
  rolledAt: string;
  who: string;
  avatar: string | null;
  frame: string | null;
}

export interface PullGaps {
  rarity: Rarity;
  /** The pack's published rate for the tier (%); null on the global feed. */
  pct: number | null;
  /** 1 / pct in draws — where the reference line sits; null without a rate. */
  expected: number | null;
  /** Observed mean gap over every hit on record; null with no hits. */
  avg: number | null;
  /** Observed mean over the newest 20 hits. */
  last20: number | null;
  /** Pulls since the newest hit — the drought bar. */
  current: number;
  /** Newest first. */
  hits: PullGapHit[];
}

/**
 * The tier's hit history for the stats chart — the global ledger, or one
 * pack's with `packSlug`. Null (never mock) on a backend failure or a
 * malformed body: the chart renders its unavailable state.
 */
export async function getPullGaps(
  rarity: Rarity,
  packSlug?: string,
): Promise<PullGaps | null> {
  // `?rarity=…&pack_id=…`, in that order, as the hand-built querystring had
  // it — the SDK serializes to the same URL.
  const r = await store.get('/store/pulls/gaps', PullGapsSchema, {
    ...PUBLIC,
    query: { rarity, ...(packSlug ? { pack_id: packSlug } : {}) },
  });
  // Null (never mock) for a backend failure AND for a malformed body: the
  // chart renders its unavailable state, and /api/pull-gaps turns that null
  // into a 503 rather than memoising it.
  if (!r.ok) return null;
  const parsed = r.data;
  return {
    rarity: parsed.rarity as Rarity,
    pct: parsed.pct ?? null,
    expected: parsed.expected ?? null,
    avg: parsed.avg ?? null,
    last20: parsed.last20 ?? null,
    current: parsed.current,
    hits: parsed.hits.map((h) => ({
      id: h.id,
      gap: h.gap,
      rolledAt: h.rolled_at,
      who: h.who ?? 'Anonymous',
      avatar: h.avatar_url ?? (h.seed != null ? avatarForSeed(h.seed) : null),
      frame: h.frame_url ?? null,
    })),
  };
}
