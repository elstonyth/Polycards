'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import Link from 'next/link';
import { ArrowUpRight, Truck } from 'lucide-react';
import PackCategoryTabs from '@/components/PackCategoryTabs';
import { HeroFreePack } from '@/components/home/HeroFreePack';
import { useShelfCategory } from '@/components/home/ShelfCategory';
import { BUYBACK_RATE_LABEL } from '@/lib/buyback-copy';
import type { PackTab } from '@/lib/packs-data';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { cn } from '@/lib/utils';
import type { StageCategory, StagePack } from './contract';
import { Stage3dCanvas, useStage3d } from './Stage3dProvider';
import StageInfo from './StageInfo';
import StageLoader, { useStageLoaderUp } from './StageLoader';
import { LOADER_LATE_AT_MS } from './stage-loader-script';
import StageTrack, { stageStartIndex } from './StageTrack';
import styles from './pack-stage.module.css';

/** What the live region says once the track rests on a pack. */
export function stageAnnouncement(
  pack: Pick<StagePack, 'name' | 'priceLabel' | 'soldOut'>,
  index: number,
  count: number,
): string {
  return `${pack.name}, ${pack.priceLabel}${pack.soldOut ? ', sold out' : ''}. ${index + 1} of ${count}.`;
}

const nounOf = (packs: readonly StagePack[]): 'pack' | 'capsule' =>
  packs.length > 0 && packs.every((p) => p.ticket) ? 'capsule' : 'pack';

// Without JS: every category's panel shows (each with its name), and each
// carousel falls back to a swipeable snap row (phones) or a grid (desktop).
// The panel rule sits in Tailwind's base layer: preflight's `[hidden]` rule is
// `!important` there, and a layered !important beats any unlayered one.
const NO_SCRIPT_CSS = `
@layer base{[data-stage-panel][hidden]{display:block!important}}
[data-stage-panel-name]{position:static!important;width:auto!important;height:auto!important;margin:2rem 0 .75rem!important;clip:auto!important;clip-path:none!important;overflow:visible!important;white-space:normal!important}
[data-stage-nav],[data-stage-info],[data-stage-count]{display:none!important}
[data-stage-viewport]{height:auto!important;perspective:none!important;touch-action:auto!important;user-select:auto!important;overflow-x:auto;scroll-snap-type:x mandatory;padding-bottom:1rem}
[data-stage-row]{position:static!important;transform:none!important;width:max-content;gap:1rem;padding:0 1rem}
[data-stage-tile]{width:auto!important;scroll-snap-align:center}
[data-stage-hit]{pointer-events:auto!important}
[data-stage-pose]{transform:none!important;opacity:1!important}
[data-stage-label]{transform:none!important;opacity:1!important}
[data-stage-art] img{filter:none!important}
@media (min-width:1024px){[data-stage-viewport]{overflow:visible}[data-stage-row]{display:grid!important;grid-template-columns:repeat(auto-fill,minmax(13rem,1fr));width:auto}[data-stage-art]{width:10.75rem!important;height:20rem!important}}
`;

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
  freePackPromo,
  debug = false,
}: {
  categories: StageCategory[];
  tabs: PackTab[];
  /** A free welcome pack is on offer to a new visitor (getFreePackPromo). */
  freePackPromo: boolean;
  debug?: boolean;
}) {
  const { active, pick } = useShelfCategory();
  const stage3d = useStage3d();
  const reduced = usePrefersReducedMotion();
  const hostRef = useRef<HTMLElement>(null);
  // Never in the server HTML: a visitor whose JS never runs must not get an
  // inert page. Client-side, the stage is inert while the loader covers it.
  const loaderUp = useStageLoaderUp(false);
  const [revealed, setRevealed] = useState(false);

  // The centred pack per category (the info block follows the active one).
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [announcement, setAnnouncement] = useState('');
  const selectedIn = (c: StageCategory) =>
    selected[c.id] ?? stageStartIndex(c.packs);

  // A tab pick goes through the provider, which times the switch for the CSS
  // tiles and the canvas alike: 250 ms sink, then `apply` (the shared pick, so
  // Just Pulled follows), then a 450 ms rise. A newer pick supersedes an older
  // one, whose `apply` never runs. The tab lights at once.
  const { swapCategory, holdIntro, playIntro } = stage3d;
  const [pending, setPending] = useState<string | null>(null);
  const pickTab = (id: string) => {
    if (id === (pending ?? active)) return;
    setPending(id);
    void swapCategory(() => {
      const c = categories.find((x) => x.id === id);
      const start = c ? stageStartIndex(c.packs) : 0;
      // A switched category starts again on its first pack in stock.
      setSelected((prev) => ({ ...prev, [id]: start }));
      pick(id);
      setPending((p) => (p === id ? null : p));
      const p = c?.packs[start];
      if (c && p) setAnnouncement(stageAnnouncement(p, start, c.packs.length));
    });
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
    } else if (wasUpRef.current && !leftRef.current) {
      // The loader went without its exit (failed to load, gave up): the packs
      // must still come in, never stay parked at the float-in's start.
      onLoaderLeave();
    }
  }, [loaderUp, holdIntro, onLoaderLeave]);

  const category =
    categories.find((c) => c.id === active) ?? categories[0] ?? null;
  const tab = tabs.find((t) => t.id === category?.id);
  const at = category ? selectedIn(category) : 0;
  const pack = category?.packs[at] ?? null;

  const select = useCallback((id: string, index: number) => {
    setSelected((prev) =>
      prev[id] === index ? prev : { ...prev, [id]: index },
    );
  }, []);
  const settle = useCallback((c: StageCategory, index: number) => {
    const p = c.packs[index];
    if (p) setAnnouncement(stageAnnouncement(p, index, c.packs.length));
  }, []);

  const empty = categories.length === 0;
  const noun = category ? nounOf(category.packs) : 'pack';

  return (
    <>
      <StageLoader onLeave={onLoaderLeave} />
      <section
        ref={hostRef}
        aria-roledescription="carousel"
        aria-label={noun === 'capsule' ? 'Capsules' : 'Packs'}
        data-stage-root=""
        data-revealed={revealed ? '1' : undefined}
        inert={loaderUp || undefined}
        className={cn(
          styles.stage,
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
          <h1 className="text-center font-heading text-[clamp(1.5rem,6.4vw,1.875rem)] leading-[1.05] tracking-[-0.03em] text-white lg:text-[clamp(2rem,2.6vw,2.75rem)]">
            Open packs. Pull real cards.
          </h1>
          {tabs.length > 1 && (
            <div className="w-full max-w-xl">
              <PackCategoryTabs
                categories={tabs}
                active={pending ?? active}
                onChange={pickTab}
              />
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
            <div className="relative mt-6 lg:mt-8">
              {categories.map((c, ci) => {
                const tabName = tabs.find((t) => t.id === c.id)?.tab ?? c.id;
                const isVisible = c.id === visible;
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
                      packs={c.packs}
                      active={isVisible}
                      noun={nounOf(c.packs)}
                      reduced={reduced}
                      priority={ci === 0}
                      host={hostRef}
                      selected={selectedIn(c)}
                      onSelect={(i) => select(c.id, i)}
                      onSettle={(i) => settle(c, i)}
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
                  count={category.packs.length}
                  categoryName={tab?.tab ?? category.id}
                />
                <HeroFreePack promo={freePackPromo} />
              </div>
            )}
          </>
        )}

        <p className="px-fluid mt-6 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-[11px] text-neutral-400 lg:text-xs">
          <span className="flex items-center gap-1.5">
            <Truck className="h-3.5 w-3.5" aria-hidden />
            Ships to Malaysia &amp; Singapore
          </span>
          <span className="h-3 border-l border-white/15" aria-hidden />
          <span>{BUYBACK_RATE_LABEL} vault buyback</span>
          <span className="h-3 border-l border-white/15" aria-hidden />
          <Link
            href="/how-it-works"
            className="flex min-h-11 items-center gap-1 font-semibold text-neutral-300 transition-colors hover:text-white"
          >
            How it works <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
        </p>

        {/* Polite, and only once the track rests: never during a drag. */}
        <p aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </p>

        <noscript>
          <style dangerouslySetInnerHTML={{ __html: NO_SCRIPT_CSS }} />
        </noscript>

        {debug && (
          <p className="fixed bottom-24 left-3 z-[60] rounded-lg bg-black/80 px-3 py-2 font-mono text-[11px] text-neutral-300 ring-1 ring-white/10 lg:bottom-3">
            mode {stage3d.mode} · ready {String(stage3d.ready)} · {active} ·{' '}
            {at + 1}/{category?.packs.length ?? 0}
          </p>
        )}
      </section>
    </>
  );
}
