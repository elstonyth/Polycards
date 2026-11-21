'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { flushSync } from 'react-dom';
import PackCategoryTabs from '@/components/PackCategoryTabs';
import { useShelfCategory } from '@/components/home/ShelfCategory';
import type { PackTab } from '@/lib/packs-data';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { cn } from '@/lib/utils';
import type { StageCategory, StagePack } from './contract';
import { Stage3dCanvas, useStage3d } from './Stage3dProvider';
import StageInfo from './StageInfo';
import StageLoader, { useStageLoaderUp } from './StageLoader';
import { LOADER_LATE_AT_MS } from './stage-loader-script';
import StageChips from './StageChips';
import {
  ALL_FILTER,
  filterLabel,
  languagesOf,
  rowKeyOf,
  rowPacks,
  rowStart,
  sameFilter,
  stageAnnouncement,
  stageChips,
  stageStartIndex,
  type StageFilter,
} from './stage-filter';
import StageTrack, { type StageTrackHandle } from './StageTrack';
import { loadSpinKit } from './stage-spin-load';
import { takeArrival } from './stage-arrival';
import styles from './pack-stage.module.css';

const nounOf = (packs: readonly StagePack[]): 'pack' | 'capsule' =>
  packs.length > 0 && packs.every((p) => p.ticket) ? 'capsule' : 'pack';

/**
 * The home pack stage (plan sections 1, 3, 7), complete without any 3D: the
 * compact heading, the franchise tabs (driving the shared ShelfCategory pick,
 * so Just Pulled follows), one carousel per category (every category's tiles
 * are in the server HTML; the inactive ones are `hidden`), the centred pack's
 * info block, the live region and the first-visit loader.
 */
export default function PackStage({
  categories,
  tabs,
  children,
}: {
  categories: StageCategory[];
  tabs: PackTab[];
  /**
   * The page below the stage. It is laid out from the pin's end and scrolls
   * up OVER the stuck panel during the exit (as Ciao's FAQ scrolls over its
   * fixed canvas), so it is rendered here, after the pin.
   */
  children?: ReactNode;
}) {
  const { active, pick } = useShelfCategory();
  const stage3d = useStage3d();
  const reduced = usePrefersReducedMotion();
  const hostRef = useRef<HTMLElement>(null);
  const flowRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  // the shown row's track: the lineup's pick moves it and selects its pack
  const trackRef = useRef<StageTrackHandle>(null);
  const empty0 = categories.length === 0;

  // The pin (10.2 as corrected by the Ciao motion sheet): the panel sticks
  // under the site header for the spin (1.75 panels) and the exit (1.25
  // panels), then the page below covers it. The spin chunk measures the range
  // from these elements, sets the panel's flags and pages the spin.
  // Never in the server HTML: a visitor whose JS never runs must not get an
  // inert page. Client-side, the stage is inert while the loader covers it.
  const loaderUp = useStageLoaderUp(false);
  const {
    values: spinValues,
    state: stageState,
    wake,
    show: showStage,
  } = stage3d;
  // The focused pack's blocks (rendered by the spin chunk's focused view).
  const [focusUi, setFocusUi] = useState<ReactNode>(null);
  useEffect(() => {
    const flow = flowRef.current;
    const wrap = wrapRef.current;
    const panel = hostRef.current;
    // After the loader has gone (its exit is never slowed by the chunk).
    if (!flow || !wrap || !panel || reduced || loaderUp) return;
    let ctl: { stop(): void } | null = null;
    let live = true;
    const t = setTimeout(() => {
      loadSpinKit().then(
        (m) => {
          if (!live) return;
          const c = m.startSpin({
            stage: {
              state: stageState,
              wake,
              values: spinValues,
              show: showStage,
            },
            ui: setFocusUi,
            row: () => trackRef.current,
          });
          c.bind({ flow, wrap, panel, empty: empty0 });
          ctl = c;
        },
        // No spin chunk: the page stays step 1 (one screen, never paged).
        () => {},
      );
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
      ctl?.stop();
    };
  }, [spinValues, stageState, wake, showStage, empty0, reduced, loaderUp]);

  const [revealed, setRevealed] = useState(false);

  // The centred pack per category (the info block follows the active one).
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [announcement, setAnnouncement] = useState('');

  // The row each category shows: its chip and language (both default to every
  // pack: the approved row). Never stored, never in the URL.
  const [filters, setFilters] = useState<Record<string, StageFilter>>({});
  const [rowStarts, setRowStarts] = useState<Record<string, number>>({});
  const filterOf = (id: string): StageFilter => filters[id] ?? ALL_FILTER;
  const rows = useMemo(
    () =>
      new Map(
        categories.map((c) => [c.id, rowPacks(c, filters[c.id] ?? ALL_FILTER)]),
      ),
    [categories, filters],
  );
  const rowOf = (c: StageCategory) => rows.get(c.id) ?? c.packs;
  const selectedIn = (c: StageCategory) =>
    selected[c.id] ?? rowStarts[c.id] ?? stageStartIndex(rowOf(c));

  // A tab, chip or language pick goes through the provider, which times the
  // change for the CSS tiles and the canvas alike: 250 ms sink, then `apply`,
  // then a 450 ms rise. The coming row is named at the tap, so its 3D packs
  // load during the sink. `apply` commits synchronously (flushSync): the new
  // row is posed, centred and attached before the rise's first frame. A newer
  // pick supersedes an older one, whose `apply` never runs. The tab or chip
  // lights at once.
  const { swapCategory, holdIntro, playIntro } = stage3d;
  const [pending, setPending] = useState<string | null>(null);
  const [pendingRow, setPendingRow] = useState<{
    cat: string;
    f: StageFilter;
  } | null>(null);
  const changeRow = (catId: string, f: StageFilter) => {
    const c = categories.find((x) => x.id === catId);
    if (!c) return;
    const switching = catId !== active;
    const nextRow = rowPacks(c, f);
    // The same category: open on the pack that was centred if it stays.
    const centred = switching ? null : (rowOf(c)[selectedIn(c)]?.id ?? null);
    const start = rowStart(nextRow, centred);
    setPending(switching ? catId : null);
    setPendingRow({ cat: catId, f });
    void swapCategory(
      () => {
        flushSync(() => {
          // A category switch resets every row to "All".
          setFilters((prev) =>
            switching ? { [catId]: f } : { ...prev, [catId]: f },
          );
          setRowStarts((prev) => ({ ...prev, [catId]: start }));
          setSelected((prev) => ({ ...prev, [catId]: start }));
          // The shared pick, so Just Pulled follows (the category only).
          if (switching) pick(catId);
          setPending((p) => (p === catId ? null : p));
          setPendingRow((p) =>
            p && p.cat === catId && sameFilter(p.f, f) ? null : p,
          );
        });
        const p = nextRow[start];
        if (p) setAnnouncement(stageAnnouncement(p, start, nextRow.length));
      },
      { packs: nextRow, centre: start },
    );
  };
  const target = pending ?? active;
  const shownFilter =
    pendingRow?.cat === target ? pendingRow.f : filterOf(target);
  const pickTab = (id: string) => {
    if (id === target) return;
    changeRow(id, ALL_FILTER);
  };
  const pickRowFilter = (next: StageFilter) => {
    if (sameFilter(next, shownFilter)) return;
    changeRow(target, next);
  };
  const visible = active;

  // While the loader covers the page the float-in waits at its start; it plays
  // as the loader starts to leave.
  const leftRef = useRef(false);
  const wasUpRef = useRef(false);
  const onLoaderLeave = useCallback(() => {
    if (leftRef.current || !wasUpRef.current) return;
    leftRef.current = true;
    setRevealed(true);
    void playIntro();
  }, [playIntro]);
  useEffect(() => {
    if (loaderUp) {
      // Hydrated too late for a reveal: the page is already showing (CSS
      // failsafe), so no hold and no float-in; StageLoader lets go at once.
      if (wasUpRef.current || performance.now() > LOADER_LATE_AT_MS) return;
      wasUpRef.current = true;
      holdIntro();
    } else if (!wasUpRef.current && takeArrival()) {
      // "All packs" from a pack page: the float-in (instant under reduced motion)
      wasUpRef.current = true;
      onLoaderLeave();
    } else if (wasUpRef.current && !leftRef.current) {
      // The loader went without its exit (failed to load, gave up): the packs
      // must still come in, never stay parked at the float-in's start.
      onLoaderLeave();
    }
  }, [loaderUp, holdIntro, onLoaderLeave]);

  const category =
    categories.find((c) => c.id === active) ?? categories[0] ?? null;
  const tab = tabs.find((t) => t.id === category?.id);
  const row = category ? rowOf(category) : [];
  const at = category ? selectedIn(category) : 0;
  const pack = row[at] ?? null;

  const select = useCallback((id: string, index: number) => {
    setSelected((prev) =>
      prev[id] === index ? prev : { ...prev, [id]: index },
    );
  }, []);
  const settle = useCallback((packs: readonly StagePack[], index: number) => {
    const p = packs[index];
    if (p) setAnnouncement(stageAnnouncement(p, index, packs.length));
  }, []);

  // The chip row: the target category's chips (lit at the tap). A category
  // with none (Poly) keeps the last chips faded in place, so the row's room,
  // and with it the whole stage, never moves on a category switch.
  const targetCat = categories.find((c) => c.id === target) ?? category;
  const hasRowControls = (c: StageCategory) =>
    stageChips(c).length > 0 || languagesOf(c, ALL_FILTER).length > 0;
  const anyChips = categories.some(hasRowControls);
  const chipsOn = !!targetCat && hasRowControls(targetCat);
  const chipCat = chipsOn
    ? targetCat
    : category && hasRowControls(category)
      ? category
      : (categories.find(hasRowControls) ?? null);
  const chipFilter = chipsOn ? shownFilter : ALL_FILTER;

  const empty = categories.length === 0;
  const noun = category ? nounOf(category.packs) : 'pack';

  return (
    <div ref={flowRef} data-home-flow="" className={styles.flow}>
      <StageLoader onLeave={onLoaderLeave} />
      {/* The pin: the panel sticks through the spin and the exit. */}
      <div
        ref={wrapRef}
        data-spin-wrap=""
        className={cn(styles.spinWrap, empty && styles.spinOff)}
      >
        <section
          ref={hostRef}
          aria-roledescription="carousel"
          aria-label={noun === 'capsule' ? 'Capsules' : 'Packs'}
          data-stage-root=""
          data-revealed={revealed ? '1' : undefined}
          inert={loaderUp || undefined}
          className={cn(
            styles.stage,
            styles.panel,
            'isolate w-full pb-8 pt-5 lg:pb-10 lg:pt-8',
          )}
        >
          {/* The 3D layer's canvas host: first child, under every tile. */}
          <Stage3dCanvas />

          {/* Two soft pools of neutral light, as the /slots header: no colour,
            no blur, never moves. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[40rem] bg-[radial-gradient(50%_55%_at_50%_42%,rgba(255,255,255,0.07),transparent_70%),radial-gradient(35%_40%_at_12%_0%,rgba(255,255,255,0.05),transparent_70%)]"
          />

          <div className="px-fluid flex flex-col items-center gap-4 lg:gap-5">
            <h1
              data-stage-head=""
              className="text-center font-heading text-[clamp(1.5rem,6.4vw,1.875rem)] leading-[1.05] tracking-[-0.03em] text-white lg:text-[clamp(2rem,2.6vw,2.75rem)]"
            >
              Open packs. Pull real cards.
            </h1>
            {(tabs.length > 1 || (anyChips && !empty)) && (
              // The pill and, hanging from it, the sorting control's own 24 px
              // row (in the gap the pill always had above the packs, so the
              // stage sits where it did before). Above the tiles: the control's
              // panel draws over the stage and never moves it.
              <div
                data-stage-head=""
                className={cn(styles.pillWrap, 'relative z-30 w-full max-w-xl')}
              >
                {tabs.length > 1 && (
                  <PackCategoryTabs
                    categories={tabs}
                    active={target}
                    onChange={pickTab}
                  />
                )}
                {anyChips && !empty && (
                  <div className="flex h-6 justify-center">
                    {chipCat && (
                      <StageChips
                        category={chipCat}
                        filter={chipFilter}
                        label={filterLabel(chipCat, chipFilter)}
                        off={!chipsOn}
                        onPick={pickRowFilter}
                      />
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          {empty ? (
            <p className="px-fluid mx-auto mt-8 max-w-xl">
              <span className="block rounded-2xl border border-white/10 bg-neutral-900 px-4 py-10 text-center text-[13px] text-neutral-400">
                No packs available right now — check back soon.
              </span>
            </p>
          ) : (
            <>
              <div
                className={cn(
                  'relative',
                  anyChips ? 'lg:mt-1' : 'mt-6 lg:mt-8',
                )}
              >
                {categories.map((c, ci) => {
                  const tabName = tabs.find((t) => t.id === c.id)?.tab ?? c.id;
                  const isVisible = c.id === visible;
                  const packs = rowOf(c);
                  return (
                    <div key={c.id} data-stage-panel={c.id} hidden={!isVisible}>
                      <h2
                        data-stage-panel-name=""
                        className="sr-only px-fluid font-heading text-xl text-white"
                      >
                        {tabName}
                      </h2>
                      <StageTrack
                        categoryId={c.id}
                        packs={packs}
                        startAt={rowStarts[c.id]}
                        rowKey={rowKeyOf(c.id, filterOf(c.id))}
                        active={isVisible}
                        noun={nounOf(c.packs)}
                        reduced={reduced}
                        priority={ci === 0}
                        host={hostRef}
                        handle={isVisible ? trackRef : undefined}
                        selected={selectedIn(c)}
                        onSelect={(i) => select(c.id, i)}
                        onSettle={(i) => settle(packs, i)}
                      />
                    </div>
                  );
                })}
              </div>

              {pack && category && (
                <div
                  data-stage-info=""
                  data-stage-fade=""
                  // Desktop: up into the label band, which only neighbours use.
                  className="px-fluid relative mt-3 flex flex-col items-center lg:-mt-9"
                  style={{ '--fade-delay': '120ms' } as CSSProperties}
                >
                  <StageInfo
                    pack={pack}
                    index={at}
                    count={row.length}
                    categoryName={tab?.tab ?? category.id}
                  />
                </div>
              )}
            </>
          )}

          {/* Polite, and only once the track rests: never during a drag. */}
          <p aria-live="polite" aria-atomic="true" className="sr-only">
            {announcement}
          </p>
          {focusUi}
        </section>
      </div>

      {/* After the pin: laid out from its end, it rises over the stuck panel
          during the exit. The page's server-rendered sections, in order. */}
      <div data-spin-after="" className={styles.spinAfter}>
        {children}
      </div>
    </div>
  );
}
