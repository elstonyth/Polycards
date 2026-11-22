import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getPackCategories, getPackHighlights } from '@/lib/data/packs';
import {
  CAT_ICON,
  packTabs,
  type PackCard,
  type PackCategory,
} from '@/lib/packs-data';
import { ShelfCategoryProvider } from '@/components/home/ShelfCategory';
import PackStage from '@/components/pack-stage/PackStage';
import { Stage3dProvider } from '@/components/pack-stage/Stage3dProvider';
import { StageNoScript } from '@/components/pack-stage/StageNoScript';
import { toStageCategories } from '@/components/pack-stage/stage-packs';
import { flowSeedFromHighlights } from '@/components/pack-flow/flow-seed';
import {
  FlowSections,
  loadFlowData,
} from '@/components/pack-flow/FlowSections';
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
    // Only a pack the flow can start on, by the page's own check on the
    // catalogue the page reads anyway (the row's order never decides whether
    // it can); every other focus costs no pack read and is sent on.
    const categories = await getPackCategories();
    if (flowStart({ categories, tabs: packTabs(categories), id: focus })) {
      const { title } = await packMetadata(focus);
      if (title && title !== UNKNOWN_PACK_TITLE)
        return { title, robots: ROBOTS };
    }
  }
  return { title: 'Home preview', robots: ROBOTS };
}

const STAGE_MODES: readonly GateMode[] = ['flat', '3d', 'lite'];

/** A `?more=` copy's id: its source pack's id and a number. */
const QA_COPY = /^(.+)~qa\d+$/;
/** The pack a `?more=` copy was made from (any other id: itself). */
const qaSource = (id: string) => QA_COPY.exec(id)?.[1] ?? id;

/**
 * The preview's QA catalogue: `hidden` packs left out, `grouped` packs moved
 * to a new group (as an admin category the storefront names by its id), then
 * `more` copies of the first row's packs appended to it under new ids.
 */
function qaCatalogue(
  catalogue: PackCategory[],
  hidden: ReadonlySet<string>,
  more: number,
  grouped: ReadonlySet<string>,
): PackCategory[] {
  if (hidden.size === 0 && more === 0 && grouped.size === 0) return catalogue;
  const moved = catalogue
    .flatMap((c) => c.packs)
    .filter((p) => grouped.has(p.id));
  const kept = [
    ...catalogue.map((c) => ({
      ...c,
      packs: c.packs.filter((p) => !hidden.has(p.id) && !grouped.has(p.id)),
    })),
    ...(moved.length > 0
      ? [
          {
            id: 'basketball',
            tab: 'Basketball',
            heading: 'Basketball Packs',
            icon: CAT_ICON.basketball,
            packs: moved,
          },
        ]
      : []),
  ];
  const first = kept.find((c) => c.packs.length > 0);
  if (!first || more === 0) return kept;
  const copies = Array.from({ length: more }, (_, k) => {
    const src = first.packs[k % first.packs.length]!;
    return { ...src, id: `${src.id}~qa${k + 1}`, name: `${src.name} ${k + 1}` };
  });
  return kept.map((c) =>
    c === first ? { ...c, packs: [...c.packs, ...copies] } : c,
  );
}

type Highlights = Awaited<ReturnType<typeof getPackHighlights>>;

/** Every pack's starting data for its focused view, by pack id. */
function seedsOf(
  categories: PackCategory[],
  highlightOf: ReadonlyMap<string, Highlights | undefined>,
) {
  return Object.fromEntries(
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
}

/**
 * Homepage pack stage preview (docs/research/home-3d/pack-stage/plan.md).
 * 404 unless `next dev` or the server runs with HOME_PREVIEW=1. Reading
 * searchParams keeps the route dynamic, so the gate is checked per request
 * (as /loader-preview).
 *
 * Query (preview only, read here and passed down as props):
 * `?stage=flat|3d|lite` forces the 3D mode;
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
  // QA only: `?soldout=gold-pack,cr` shows those packs sold out, since the live
  // catalogue may have none.
  const forcedSoldOut = new Set(one('soldout').split(',').filter(Boolean));
  // QA only: `?jp=delta-reign,ah` marks those packs Japanese for this request,
  // so the stage's language control can be seen before a real Japanese pack
  // exists. Preview only; never on the real homepage.
  const forcedJp = new Set(one('jp').split(',').filter(Boolean));
  // QA only: a changed catalogue without touching the admin. `?hide=<id>,<id>`
  // leaves those packs out; `?more=<n>` adds n copies of the first row's
  // packs under new ids (no 3D set, no tiers: a pack added in the admin with
  // its picture only); `?no3d=<id>,<id>` draws those packs from their
  // picture, as a pack with no bundled 3D set.
  const hidden = new Set(one('hide').split(',').filter(Boolean));
  const more = Math.min(48, Math.max(0, Math.floor(Number(one('more')) || 0)));
  const no3d = new Set(one('no3d').split(',').filter(Boolean));
  // `?group=<id>,<id>` moves those packs into a group of their own (a new tab).
  const grouped = new Set(one('group').split(',').filter(Boolean));

  // shortcut: duplicated from src/app/page.tsx (catalogue and top-chase
  // lookups). Remove at integration. The sections below the lineup read only
  // what they list (FlowSections.tsx).
  const [catalogue, flowData] = await Promise.all([
    getPackCategories(),
    loadFlowData(),
  ]);
  const reshaped = qaCatalogue(catalogue, hidden, more, grouped);
  const categories =
    forcedSoldOut.size === 0 && forcedJp.size === 0
      ? reshaped
      : reshaped.map((c) => ({
          ...c,
          packs: c.packs.map((p) => ({
            ...p,
            ...(forcedSoldOut.has(p.id) ? { inStock: false } : {}),
            ...(forcedJp.has(p.id) ? { language: 'jp' as const } : {}),
          })),
        }));
  const packs = categories.flatMap((c) => c.packs);
  const highlights = await Promise.all(
    packs.map((pack) => getPackHighlights(qaSource(pack.id))),
  );
  const chaseByPack = new Map<string, PackCard | null>(
    packs.map((pack, i) => [pack.id, highlights[i]?.chase ?? null]),
  );
  // The focused pack view's starting data, read by its lazily loaded chunk:
  // data in the page, no script.
  const highlightOf = new Map(packs.map((pack, i) => [pack.id, highlights[i]]));
  const seeds = seedsOf(categories, highlightOf);
  const stageCategories = toStageCategories(categories, chaseByPack).map((c) =>
    no3d.size === 0
      ? c
      : {
          ...c,
          packs: c.packs.map((p) =>
            no3d.has(p.id) ? { ...p, art3d: null } : p,
          ),
        },
  );
  const tabs = packTabs(categories);
  const focus = one('focus');
  const start = focus
    ? flowStart({ categories: stageCategories, tabs, id: focus })
    : null;
  // the visitor's query (utm, fbclid) rides along to the pack page
  const packPage = packPagePath(
    focus,
    new URLSearchParams(
      Object.entries(query).filter(
        (e): e is [string, string] => typeof e[1] === 'string',
      ),
    ),
  );
  if (focus && !start) redirect(packPage);
  // The brand loader's pre-paint gate is in the root layout's <head>
  // (stage-loader-script.ts, STAGE_LOADER_PATHS); it reads ?loader= itself.
  return (
    <div className="w-full">
      {start && (
        <script
          dangerouslySetInnerHTML={{
            __html: flowEntryScript(focus, packPage),
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
        <Stage3dProvider override={stage}>
          {/* The page below the stage, in the flow's order:
              PackStage lays it out after the pin, and it rises over the
              pinned panel during the spin's exit. */}
          <PackStage
            categories={stageCategories}
            tabs={tabs}
            start={start ? { ...start, id: focus } : undefined}
          >
            <FlowSections data={flowData} />
          </PackStage>
        </Stage3dProvider>
      </ShelfCategoryProvider>
    </div>
  );
}
