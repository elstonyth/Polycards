import {
  getPackCategories,
  getPackDetail,
  getRecentPulls,
} from '@/lib/data/packs';
import { getLeaderboard } from '@/lib/data/leaderboard';
import { priceNumber, type PackCard } from '@/lib/packs-data';
import HeroBoard from '@/components/home/HeroBoard';
import PullsMarquee from '@/components/home/PullsMarquee';
import TierShelf from '@/components/home/TierShelf';
import HowItRips from '@/components/home/HowItRips';
import RecentPullsSection from '@/components/RecentPullsSection';
import TheGame from '@/components/home/TheGame';
import FinalCta from '@/components/home/FinalCta';

// Pack catalog + live pulls come fresh from the backend on every request.
export const dynamic = 'force-dynamic';

/** How many shelf tiles get a per-pack top-chase lookup (one request each). */
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
  const lookupPacks = [
    ...new Set([
      ...(featured ? [featured] : []),
      ...packs.slice(0, CHASE_LOOKUPS),
    ]),
  ];
  const details = await Promise.all(
    lookupPacks.map((p) => getPackDetail(p.id)),
  );
  const chaseByPack = new Map<string, PackCard | null>(
    lookupPacks.map((p, i) => [p.id, details[i]?.topHits[0] ?? null]),
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

      {/* 03 — trust engine */}
      <HowItRips />

      {/* 04 — live proof */}
      <RecentPullsSection initialPulls={pulls} />

      {/* 05 — podium + loop teaser */}
      <TheGame topRippers={topRippers} />

      {/* 06 — closer */}
      <FinalCta />
    </div>
  );
}
