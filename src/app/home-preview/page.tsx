import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import {
  getPackCategories,
  getPackHighlights,
  getRecentPulls,
} from '@/lib/data/packs';
import { getLeaderboard } from '@/lib/data/leaderboard';
import { getFreePackPromo } from '@/lib/data/free-pack';
import { cached } from '@/lib/ttl-cache';
import { packTabs, type PackCard } from '@/lib/packs-data';
import { ShelfCategoryProvider } from '@/components/home/ShelfCategory';
import PackStage from '@/components/pack-stage/PackStage';
import { Stage3dProvider } from '@/components/pack-stage/Stage3dProvider';
import { StageNoScript } from '@/components/pack-stage/StageNoScript';
import { toStageCategories } from '@/components/pack-stage/stage-packs';
import { flowSeedFromHighlights } from '@/components/pack-flow/flow-seed';
import { FlowSections } from '@/components/pack-flow/FlowSections';
import { FOCUS_SEEDS_ID } from '@/components/pack-stage/stage-focus-seeds';
import { flowStart } from '@/components/pack-flow/flow-start';
import { packPagePath } from '@/components/pack-stage/stage-focus-marks';
import { homePreviewOn } from '@/lib/preview-switch';
import { UNKNOWN_PACK_TITLE, packMetadata } from '@/lib/pack-metadata';
import { flowEntryScript } from '@/components/pack-stage/stage-loader-script';
import type {
  GateMode,
  StageOverride,
} from '@/components/pack-stage/stage-gate';

const ROBOTS: Metadata['robots'] = { index: false, follow: false };

/**
 * The preview's title; a load onto a pack's own address (`?focus=<id>`) the
 * flow can start on carries that pack's title, as the pack page does.
 */
export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { focus } = await searchParams;
  if (homePreviewOn() && typeof focus === 'string' && focus) {
    // Only a pack the flow can start on (read from the catalogue the page
    // reads anyway); every other focus costs no pack read and is sent on.
    const categories = (await getPackCategories()).filter(
      (c) => c.packs.length > 0,
    );
    const ids = Object.fromEntries(
      categories.flatMap((c) => c.packs.map((p) => [p.id, true])),
    );
    const tabs = packTabs(categories);
    if (flowStart({ categories, tabs, seeds: ids, id: focus })) {
      const { title } = await packMetadata(focus);
      if (title && title !== UNKNOWN_PACK_TITLE)
        return { title, robots: ROBOTS };
    }
  }
  return { title: 'Home preview', robots: ROBOTS };
}

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
 * `?soldout=<id>,<id>` shows those packs sold out (QA); `?jp=<id>,<id>` marks
 * those packs Japanese (the language control's preview). `?loader=always|never`
 * (forces or skips the brand loader) is read by the layout's pre-paint script.
 * `?focus=<id>` is a load onto that pack's own address (sent here under the
 * preview switch): the flow opens on that pack, and the address goes back to
 * the pack's; a pack it cannot open, or a reduced-motion visitor, gets its
 * pack page.
 */
export default async function HomePreviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Await the query BEFORE the gate: a notFound() reached first lets the build
  // prerender the route as a static 404, and the runtime flag is never read.
  const query = await searchParams;
  if (!homePreviewOn()) notFound();
  const one = (key: string) =>
    typeof query[key] === 'string' ? (query[key] as string) : '';
  const stage: StageOverride =
    STAGE_MODES.find((m) => m === one('stage')) ?? null;
  const debug = one('debug') === '1';
  // QA only: `?soldout=gold-pack,cr` shows those packs sold out, since the live
  // catalogue may have none.
  const forcedSoldOut = new Set(one('soldout').split(',').filter(Boolean));
  // QA only: `?jp=delta-reign,ah` marks those packs Japanese for this request,
  // so the stage's language control can be seen before a real Japanese pack
  // exists. Preview only; never on the real homepage.
  const forcedJp = new Set(one('jp').split(',').filter(Boolean));

  // shortcut: duplicated from src/app/page.tsx (catalogue, feed, board,
  // free-pack offer, top-chase lookups). Remove at integration.
  const [catalogue, feed, topRippers, freePackPromo] = await Promise.all([
    getPackCategories(),
    cached('home:recent-pulls', FEED_TTL_MS, () => getRecentPulls()),
    getLeaderboard('weekly'),
    cached('home:free-pack-promo', FEED_TTL_MS, getFreePackPromo),
  ]);
  const categories =
    forcedSoldOut.size === 0 && forcedJp.size === 0
      ? catalogue
      : catalogue.map((c) => ({
          ...c,
          packs: c.packs.map((p) => ({
            ...p,
            ...(forcedSoldOut.has(p.id) ? { inStock: false } : {}),
            ...(forcedJp.has(p.id) ? { language: 'jp' as const } : {}),
          })),
        }));
  const packs = categories.flatMap((c) => c.packs);
  const highlights = await Promise.all(
    packs.map((pack) => getPackHighlights(pack.id)),
  );
  const chaseByPack = new Map<string, PackCard | null>(
    packs.map((pack, i) => [pack.id, highlights[i]?.chase ?? null]),
  );
  // The focused pack view's starting data, read by its lazily loaded chunk:
  // data in the page, no script.
  const highlightOf = new Map(packs.map((pack, i) => [pack.id, highlights[i]]));
  const seeds = Object.fromEntries(
    categories.flatMap((c) =>
      c.packs.map((pack) => [
        pack.id,
        flowSeedFromHighlights(
          { ...pack, categoryId: c.id, categoryName: c.heading, icon: c.icon },
          highlightOf.get(pack.id) ?? null,
        ),
      ]),
    ),
  );
  const stageCategories = toStageCategories(categories, chaseByPack);
  const tabs = packTabs(categories);
  const focus = one('focus');
  const start = focus
    ? flowStart({ categories: stageCategories, tabs, seeds, id: focus })
    : null;
  if (focus && !start) redirect(`/slots/${encodeURIComponent(focus)}?count=1`);
  // The brand loader's pre-paint gate is in the root layout's <head>
  // (stage-loader-script.ts, STAGE_LOADER_PATHS); it reads ?loader= itself.
  return (
    <div className="w-full">
      {start && (
        <script
          dangerouslySetInnerHTML={{
            __html: flowEntryScript(focus, packPagePath(focus)),
          }}
        />
      )}
      <StageNoScript />
      <script
        type="application/json"
        id={FOCUS_SEEDS_ID}
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(seeds).replace(/</g, '\\u003c'),
        }}
      />
      <ShelfCategoryProvider categories={tabs}>
        <Stage3dProvider override={stage} debug={debug}>
          {/* The page below the stage, in the flow's order (full-flow plan 1):
              PackStage lays it out after the pin, and it rises over the
              pinned panel during the spin's exit. */}
          <PackStage
            categories={stageCategories}
            tabs={tabs}
            start={start ? { ...start, id: focus } : undefined}
          >
            <FlowSections
              feed={feed}
              topRippers={topRippers}
              freePackPromo={freePackPromo}
              showOffer={stageCategories.length > 0}
            />
          </PackStage>
        </Stage3dProvider>
      </ShelfCategoryProvider>
    </div>
  );
}
