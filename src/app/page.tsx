import {
  getPackCategories,
  getPackChase,
  getRecentPulls,
} from '@/lib/data/packs';
import { getLeaderboard } from '@/lib/data/leaderboard';
import { priceNumber, type PackCard } from '@/lib/packs-data';
import HeroBoard from '@/components/home/HeroBoard';
import PullsMarquee from '@/components/home/PullsMarquee';
import TierShelf from '@/components/home/TierShelf';
import RecentPullsSection from '@/components/RecentPullsSection';
import TheGame from '@/components/home/TheGame';
import FinalCta from '@/components/home/FinalCta';

// The home page is the only public route whose whole tree is visitor-agnostic:
// the layout resolves auth client-side (AuthProvider / AppHeader / the free-pack
// badge are all 'use client'), and nothing here reads cookies() or headers().
// So it is rendered ONCE per window and served from the route cache, instead of
// re-running a ~158 KB React render per request — the single largest cost on the
// storefront's 1-vCPU instance under load.
//
// 15s adds no staleness the reader can perceive: the backend already serves the
// catalog and the board from its own 30s caches, and the pulls feed re-hydrates
// live on the client (use-recent-pulls polls every 10s). Every OTHER public page
// (/slots, /slots/[slug], /leaderboard) reads an auth cookie somewhere in its
// tree and must stay per-request — scale those with instances, not with this.
//
// Do NOT add `export const fetchCache` here. It would make unstable_cache skip
// its read and silently put all N pack-detail payloads back on every render of
// getPackChase below, with nothing failing.
export const revalidate = 15;

/** How many shelf tiles get a per-pack top-chase lookup (a cache read each —
 *  see getPackChase; one backend request each only on a cold miss). */
const CHASE_LOOKUPS = 16;

export default async function HomePage() {
  const [categories, pulls, topRippers] = await Promise.all([
    getPackCategories(),
    getRecentPulls(),
    // [] on any backend failure — TheGame hides the podium then.
    getLeaderboard('weekly'),
  ]);
  const packs = categories.flatMap((c) => c.packs);
  const inStock = packs.filter((p) => p.inStock !== false);
  const featured = [...inStock].sort(
    (a, b) => priceNumber(b.price) - priceNumber(a.price),
  )[0];

  // Chase lookups cover the first N tiles PLUS the featured pack, so the hero
  // never silently loses its chase when featured falls outside the first N.
  // ponytail: pools are per-pack (listPackOdds is pack_id-scoped), so these N
  // lookups are genuinely distinct. The render cost DID show up (2026-08-17:
  // ~700 KB of pool JSON per home view, TTFB 1.0–3.5 s), so the short-TTL cache
  // this comment anticipated now lives in getPackChase.
  const lookupPacks = [
    ...new Set([
      ...(featured ? [featured] : []),
      ...packs.slice(0, CHASE_LOOKUPS),
    ]),
  ];
  const chases = await Promise.all(lookupPacks.map((p) => getPackChase(p.id)));
  const chaseByPack = new Map<string, PackCard | null>(
    lookupPacks.map((p, i) => [p.id, chases[i] ?? null]),
  );

  const featuredChase = featured
    ? (chaseByPack.get(featured.id) ?? null)
    : null;

  return (
    // Full-bleed by design (CLAUDE.md): boards carry their own px-fluid
    // gutters; the marquee is the one true edge-to-edge band.
    <div className="w-full">
      {/* 01 — the spotlight slab. No packs → the shelf empty state leads. */}
      {featured && <HeroBoard pack={featured} chase={featuredChase} />}

      {/* seam — live pulls marquee (absent when no pulls) */}
      <PullsMarquee pulls={pulls} />

      {/* 02 — tier-racked shelf */}
      <TierShelf packs={packs} chaseByPack={chaseByPack} />

      {/* 03 — live proof */}
      <RecentPullsSection initialPulls={pulls} />

      {/* 04 — podium + loop teaser */}
      <TheGame topRippers={topRippers} />

      {/* 05 — closer */}
      <FinalCta />
    </div>
  );
}
