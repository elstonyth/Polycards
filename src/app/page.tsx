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

// Pack catalog + live pulls come fresh from the backend on every request.
//
// Do NOT add `export const fetchCache` here. `force-dynamic` leaves the Data
// Cache alone, which is what lets getPackChase hold the chase lookups below;
// a 'force-no-store' fetchCache makes unstable_cache skip its read and silently
// puts all N pack-detail payloads back on every render, with nothing failing.
export const dynamic = 'force-dynamic';

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
