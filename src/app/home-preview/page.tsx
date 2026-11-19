import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import {
  getPackCategories,
  getPackHighlights,
  getRecentPulls,
} from '@/lib/data/packs';
import { getLeaderboard } from '@/lib/data/leaderboard';
import { getFreePackPromo } from '@/lib/data/free-pack';
import { cached } from '@/lib/ttl-cache';
import { packTabs, type PackCard } from '@/lib/packs-data';
import PullsMarquee from '@/components/home/PullsMarquee';
import { ShelfCategoryProvider } from '@/components/home/ShelfCategory';
import RecentPullsSection from '@/components/RecentPullsSection';
import TheGame from '@/components/home/TheGame';
import TrustBoard from '@/components/home/TrustBoard';
import FinalCta from '@/components/home/FinalCta';
import PackStage from '@/components/pack-stage/PackStage';
import { Stage3dProvider } from '@/components/pack-stage/Stage3dProvider';
import { toStageCategories } from '@/components/pack-stage/stage-packs';
import type {
  GateMode,
  StageOverride,
} from '@/components/pack-stage/stage-gate';

export const metadata: Metadata = {
  title: 'Home preview',
  robots: { index: false, follow: false },
};

const STAGE_MODES: readonly GateMode[] = ['flat', '3d', 'lite'];

// shortcut: the same memo windows and keys as src/app/page.tsx, whose reads
// this page duplicates. Remove the duplicate when the stage moves onto `/`.
const FEED_TTL_MS = 5_000;

/**
 * Homepage pack stage preview (docs/research/home-3d/pack-stage/plan.md).
 * 404 unless `next dev` or the server runs with HOME_PREVIEW=1. Reading
 * searchParams keeps the route dynamic, so the gate is checked per request
 * (as /loader-preview).
 *
 * Query (preview only, read here and passed down as props):
 * `?stage=flat|3d|lite` forces the 3D mode; `?debug=1` shows the stage state;
 * `?soldout=<id>,<id>` shows those packs sold out (QA). `?loader=always|never`
 * (forces the first-visit loader) is read by the layout's pre-paint script.
 */
export default async function HomePreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Await the query BEFORE the gate: a notFound() reached first lets the build
  // prerender the route as a static 404, and the runtime flag is never read.
  const query = await searchParams;
  if (
    process.env.NODE_ENV !== 'development' &&
    process.env.HOME_PREVIEW !== '1'
  ) {
    notFound();
  }
  const one = (key: string) =>
    typeof query[key] === 'string' ? (query[key] as string) : '';
  const stage: StageOverride =
    STAGE_MODES.find((m) => m === one('stage')) ?? null;
  const debug = one('debug') === '1';
  // QA only: `?soldout=gold-pack,cr` shows those packs sold out, since the live
  // catalogue may have none.
  const forcedSoldOut = new Set(one('soldout').split(',').filter(Boolean));

  // shortcut: duplicated from src/app/page.tsx (catalogue, feed, board,
  // free-pack offer, top-chase lookups). Remove at integration.
  const [catalogue, feed, topRippers, freePackPromo] = await Promise.all([
    getPackCategories(),
    cached('home:recent-pulls', FEED_TTL_MS, () => getRecentPulls()),
    getLeaderboard('weekly'),
    cached('home:free-pack-promo', FEED_TTL_MS, getFreePackPromo),
  ]);
  const categories =
    forcedSoldOut.size === 0
      ? catalogue
      : catalogue.map((c) => ({
          ...c,
          packs: c.packs.map((p) =>
            forcedSoldOut.has(p.id) ? { ...p, inStock: false } : p,
          ),
        }));
  const packs = categories.flatMap((c) => c.packs);
  const highlights = await Promise.all(
    packs.map((pack) => getPackHighlights(pack.id)),
  );
  const chaseByPack = new Map<string, PackCard | null>(
    packs.map((pack, i) => [pack.id, highlights[i]?.chase ?? null]),
  );
  // The first-visit loader's pre-paint gate is in the root layout's <head>
  // (stage-loader-script.ts, STAGE_LOADER_PATHS); it reads ?loader= itself.
  return (
    <div className="w-full">
      <ShelfCategoryProvider categories={packTabs(categories)}>
        <Stage3dProvider override={stage} debug={debug}>
          <PackStage
            categories={toStageCategories(categories, chaseByPack)}
            tabs={packTabs(categories)}
            freePackPromo={freePackPromo}
            debug={debug}
          />
        </Stage3dProvider>

        <PullsMarquee pulls={feed.pulls} />

        <RecentPullsSection initial={feed} />
      </ShelfCategoryProvider>

      <TheGame topRippers={topRippers} />
      <TrustBoard />
      <FinalCta />
    </div>
  );
}
