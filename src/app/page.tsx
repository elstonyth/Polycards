import {
  getPackCategories,
  getPackHighlights,
  getRecentPulls,
} from '@/lib/data/packs';
import { getLeaderboard } from '@/lib/data/leaderboard';
import type { PackCard } from '@/lib/packs-data';
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
// getPackHighlights below, with nothing failing.
export const revalidate = 15;

/** How many shelf tiles get a per-pack top-chase lookup (a cache read each —
 *  see getPackHighlights; one backend request each only on a cold miss). */
const CHASE_LOOKUPS = 16;

export default async function HomePage() {
  const [categories, feed, topRippers] = await Promise.all([
    getPackCategories(),
    getRecentPulls(),
    // [] on any backend failure — TheGame hides the podium then.
    getLeaderboard('weekly'),
  ]);
  const pulls = feed.pulls;
  const packs = categories.flatMap((c) => c.packs);
  const inStock = packs.filter((p) => p.inStock !== false);
  // Cover every available pack for the hero; keep the existing shelf limit
  // for sold-out rows. Both surfaces share the cached, compact projection.
  const lookupPacks = [
    ...new Set([...inStock, ...packs.slice(0, CHASE_LOOKUPS)]),
  ];
  const highlights = await Promise.all(
    lookupPacks.map((pack) => getPackHighlights(pack.id)),
  );
  const highlightsByPack = new Map(
    lookupPacks.map((pack, index) => [pack.id, highlights[index]]),
  );
  const chaseByPack = new Map<string, PackCard | null>(
    lookupPacks.map((pack, index) => [
      pack.id,
      highlights[index]?.chase ?? null,
    ]),
  );
  const seen = new Set<string>();
  const topHits = inStock
    .flatMap((pack) =>
      (highlightsByPack.get(pack.id)?.slabs ?? []).map((card) => ({
        card,
        pack,
      })),
    )
    .sort((a, b) => (b.card.priceMyr ?? 0) - (a.card.priceMyr ?? 0))
    .filter(({ card }) => {
      if (seen.has(card.handle)) return false;
      seen.add(card.handle);
      return true;
    })
    .slice(0, 3);

  return (
    // Full-bleed by design (CLAUDE.md): boards carry their own px-fluid
    // gutters; the marquee is the one true edge-to-edge band.
    <div className="w-full">
      {/* Brand introduction remains visible with an empty or offline catalog. */}
      <HeroBoard hits={topHits} />

      {/* seam — live pulls marquee (absent when no pulls) */}
      <PullsMarquee pulls={pulls} />

      {/* 02 — tier-racked shelf */}
      <TierShelf packs={packs} chaseByPack={chaseByPack} />

      {/* 03 — live proof */}
      <RecentPullsSection initial={feed} />

      {/* 04 — podium + loop teaser */}
      <TheGame topRippers={topRippers} />

      {/* 05 — closer */}
      <FinalCta />
    </div>
  );
}
