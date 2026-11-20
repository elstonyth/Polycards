'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowLeft, Info } from 'lucide-react';
import CategoryIcon from '@/components/CategoryIcon';
import { Pill } from '@/components/ui/pill';
import { ArrowDisc } from '@/components/ui/soft';
import { rm } from '@/lib/format';
import { isTicketPack, packFacts, type PackCard } from '@/lib/packs-data';
import type { PackDetail } from '@/lib/data/packs';
import { usePackBuy } from '@/app/slots/[slug]/use-pack-buy';
import { PackBuyControls } from '@/app/slots/[slug]/PackBuyControls';
import { PackTierWalk, walkRows } from '@/app/slots/[slug]/PackTierWalk';
import {
  PackCardOverlay,
  PackPullOdds,
  PackRecentPulls,
  usePackCardOverlay,
} from '@/app/slots/[slug]/PackDetailSections';
import {
  beatOf,
  stopIndexAt,
  stopsFrom,
  type MeasuredSection,
} from './flow-stops';
import type { FlowData, FlowScrollSource, FlowStop } from './types';
import styles from './flow.module.css';

/** How long the chapter content fades before the flow leaves (section 10.11). */
export const LEAVE_FADE_MS = 250;

export type FlowChaptersProps = {
  /** The focused pack's live data (useFlowData). */
  data: FlowData;
  /** Unfocus: called once the chapters have faded out (flow-address `leave`). */
  onLeave: () => void;
  /** The reel seam (flow-address `enterReel`): Open hands the reel address here. */
  onGoToReel?: (href: string) => void;
  /**
   * The sticky panel's content: the stage section at integration. Absent, a
   * flat stand-in (the pack's own picture) holds the pack's place.
   */
  panel?: ReactNode;
  /** The stage's scroll binding (`stage3d.bindScroll`): handed the stop
   *  source once the chapters are measured; returns its own unbind. */
  bindScroll?: (source: FlowScrollSource) => () => void;
  /** The rounded stop changed (the mini header text follows it). */
  onStopChange?: (index: number, stop: FlowStop | null) => void;
  /** This focus entry's id (flow-address): the chapter is saved under it on
   *  scroll end and restored on mount (Back from the reel). */
  entryId?: string | null;
  /** Move keyboard focus to the pack name on mount (a client-side focus, not
   *  a cold load). */
  autoFocusHeading?: boolean;
};

const chapterKey = (entryId: string) => `pack-flow:chapter:${entryId}`;

/** What usePackBuy reads from a detail: only whether the pool has a card
 *  (the guest demo spin). The tier view stands in for the full pool. */
function demoDetail(data: FlowData): PackDetail | null {
  const pool: PackCard[] = (data.tiers?.tiers ?? []).flatMap(
    (t) => t.cards ?? [],
  );
  // usePackBuy reads `pool` only; the odds field is never read from this.
  const detail: Pick<PackDetail, 'topHits' | 'pool'> = { topHits: [], pool };
  return pool.length > 0 ? (detail as PackDetail) : null;
}

/** The phone's mini header, following the rounded stop: "Gold Pack" at the
 *  back, "Gold Pack · Immortal · 0.2%" on a tier, "Gold Pack · Pull Odds" at
 *  the board. The chance shows only when staff entered one. */
export function miniHeaderText(
  name: string,
  at: { kind: FlowStop['kind']; tier: number | null },
  rows: ReturnType<typeof walkRows>,
): string {
  if (at.kind === 'odds') return `${name} · Pull Odds`;
  const row =
    at.kind === 'tier' && at.tier !== null ? rows[at.tier] : undefined;
  if (!row) return name;
  const parts = [name, row.tier ? row.tier.rarity : 'All prizes'];
  if (row.tier?.chance != null) parts.push(`${row.tier.chance}%`);
  return parts.join(' · ');
}

const prefersReduced = () =>
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The details a visitor scrolls after focusing a pack (plan-step2 section 1
 * "Chapters"): stop 1 the back (here, the pack beside its facts and buy
 * controls), one stop per top tier (the tier walk), the Pull Odds board, then,
 * past the pin, Recent Pulls and the closing band.
 *
 * Composed from the pack page's own parts (src/app/slots/[slug]): usePackBuy,
 * PackBuyControls (`panel` at stop 1 on desktop, `compact` stuck under the
 * header after it, `dock` on a phone), PackTierWalk, PackPullOdds,
 * PackRecentPulls and the card overlay. Capsules get their ticket versions
 * through the same parts.
 *
 * Reports its stops (`{ y, kind }` in order, section 8) through `bindScroll`,
 * measured with a ResizeObserver, never per frame. A missing tier leaves no
 * stop; a pack without pull odds has no odds board and so no odds stop.
 */
export function FlowChapters({
  data,
  onLeave,
  onGoToReel,
  panel,
  bindScroll,
  onStopChange,
  entryId = null,
  autoFocusHeading = false,
}: FlowChaptersProps) {
  const { pack } = data;
  const tickets = isTicketPack(pack);
  const noun = tickets ? 'capsule' : 'pack';
  const buy = usePackBuy(pack, demoDetail(data), { onGoToReel });
  const overlay = usePackCardOverlay(pack.id);
  const facts = packFacts(pack);
  const rows = useMemo(
    () => (data.tiers ? walkRows(data.tiers.tiers, tickets) : []),
    [data.tiers, tickets],
  );

  const wrapperRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const walkRef = useRef<HTMLDivElement>(null);
  const oddsRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const stopsRef = useRef<FlowStop[] | null>(null);
  // The rounded stop the page rests at: what the mini header and the pack's
  // pose follow. Changes only when the rounded stop changes.
  const [at, setAt] = useState<{
    index: number;
    kind: FlowStop['kind'];
    /** Which tier stop (0-based), on a tier stop. */
    tier: number | null;
    beat: number | null;
  }>({ index: 0, kind: 'back', tier: null, beat: null });
  const [leaving, setLeaving] = useState(false);

  // ---- Stops: measured on layout changes, never per frame ----
  const measure = useCallback(() => {
    const wrapper = wrapperRef.current;
    const panelEl = panelRef.current;
    if (!wrapper || !panelEl) return;
    const y = window.scrollY;
    const panelTop = Number.parseFloat(getComputedStyle(panelEl).top) || 0;
    const sections: MeasuredSection[] = [];
    const walk = walkRef.current?.querySelector(
      '[data-testid="pack-tier-walk"]',
    );
    if (walk) {
      for (const el of Array.from(walk.children)) {
        if (el.tagName === 'SECTION') {
          sections.push({
            kind: 'tier',
            top: el.getBoundingClientRect().top + y,
          });
        }
      }
    }
    const odds = oddsRef.current?.firstElementChild;
    if (odds)
      sections.push({
        kind: 'odds',
        top: odds.getBoundingClientRect().top + y,
      });
    stopsRef.current = stopsFrom(
      wrapper.getBoundingClientRect().top + y,
      sections,
      panelTop,
      panelEl.getBoundingClientRect().height,
    );
  }, []);

  const source = useMemo<FlowScrollSource>(
    () => ({ stops: () => stopsRef.current }),
    [],
  );

  useLayoutEffect(() => {
    measure();
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(wrapper);
    if (walkRef.current) ro.observe(walkRef.current);
    if (oddsRef.current) ro.observe(oddsRef.current);
    return () => ro.disconnect();
  }, [measure, data.tiers]);

  useEffect(() => bindScroll?.(source), [bindScroll, source]);

  // ---- The rounded stop: React state only when it changes ----
  const onStopRef = useRef(onStopChange);
  useEffect(() => {
    onStopRef.current = onStopChange;
  });
  useEffect(() => {
    let raf = 0;
    let last = -1;
    const read = () => {
      raf = 0;
      const stops = stopsRef.current;
      if (!stops) return;
      const index = stopIndexAt(stops, window.scrollY);
      if (index === last) return;
      last = index;
      const stop = stops[index] ?? null;
      setAt({
        index,
        kind: stop?.kind ?? 'back',
        tier:
          stop?.kind === 'tier'
            ? stops.slice(0, index).filter((s) => s.kind === 'tier').length
            : null,
        beat: beatOf(stops, index),
      });
      onStopRef.current?.(index, stop);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(read);
    };
    read();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
    };
  }, []);

  // ---- The header's real height drives the panel (the server CSS guesses) ----
  useEffect(() => {
    const header = document.querySelector('header');
    const wrapper = wrapperRef.current;
    if (!header || !wrapper) return;
    const set = () =>
      wrapper.style.setProperty(
        '--flow-top',
        `${header.getBoundingClientRect().height}px`,
      );
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  // ---- Chapter fades: timed, at each chapter's edge (never scrubbed) ----
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    // From here the chapter fades may hide what has not arrived yet; the
    // server HTML (and a page without JS) shows everything.
    wrapper.dataset.js = '1';
    const chapters = Array.from(
      wrapper.parentElement?.querySelectorAll<HTMLElement>('[data-chapter]') ??
        [],
    );
    if (typeof IntersectionObserver === 'undefined') {
      for (const c of chapters) c.dataset.in = '1';
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) (e.target as HTMLElement).dataset.in = '1';
        }
      },
      { rootMargin: '0px 0px -12% 0px', threshold: 0.05 },
    );
    for (const c of chapters) io.observe(c);
    return () => io.disconnect();
  }, [data.tiers]);

  // ---- Save the chapter on scroll end, restore it on mount ----
  // Only once the tier view is in: before that the chapters are short (the
  // homepage fetches the tiers at focus), a restore would land on the wrong
  // place and the rows arriving above it would push it down (scroll
  // anchoring), and a save would write that wrong place back.
  const ready = data.tiers !== null;
  useEffect(() => {
    if (!entryId || !ready) return;
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    try {
      const saved = window.sessionStorage.getItem(chapterKey(entryId));
      if (saved !== null) {
        const top = wrapper.getBoundingClientRect().top + window.scrollY;
        window.scrollTo({ top: top + Number(saved), behavior: 'instant' });
      }
    } catch {
      // storage blocked: start at stop 1
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const save = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const w = wrapperRef.current;
        if (!w) return;
        const top = w.getBoundingClientRect().top + window.scrollY;
        try {
          window.sessionStorage.setItem(
            chapterKey(entryId),
            String(Math.max(0, Math.round(window.scrollY - top))),
          );
        } catch {
          // storage blocked: nothing to restore later
        }
      }, 150);
    };
    window.addEventListener('scroll', save, { passive: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener('scroll', save);
    };
  }, [entryId, ready]);

  // ---- Leaving: fade the chapters, then hand over (reduced motion: at once) ----
  const leaveRef = useRef(onLeave);
  useEffect(() => {
    leaveRef.current = onLeave;
  });
  const requestLeave = useCallback(() => {
    if (prefersReduced()) {
      leaveRef.current();
      return;
    }
    setLeaving(true);
    window.setTimeout(() => leaveRef.current(), LEAVE_FADE_MS);
  }, []);

  useEffect(() => {
    // A dialog (the card overlay, the login sheet) owns Escape while open. It
    // closes itself on the same press (its own document listener), so whether
    // one was open is read before anyone handles the key: in the capture phase.
    let dialogAtStart = false;
    const onCapture = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dialogAtStart = !!document.querySelector(
          '[role="dialog"][aria-modal="true"]',
        );
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || dialogAtStart) return;
      requestLeave();
    };
    window.addEventListener('keydown', onCapture, { capture: true });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onCapture, { capture: true });
      window.removeEventListener('keydown', onKey);
    };
  }, [requestLeave]);

  useEffect(() => {
    if (autoFocusHeading) headingRef.current?.focus({ preventScroll: true });
  }, [autoFocusHeading]);

  const miniText = miniHeaderText(pack.name, at, rows);

  const price = buy.vaultCost ?? rm(buy.priceNum * buy.qty);

  return (
    <>
      <div
        ref={wrapperRef}
        className={styles.flow}
        data-stop={at.kind}
        data-beat={at.beat ?? undefined}
        data-leaving={leaving ? '1' : undefined}
        data-testid="pack-flow"
      >
        <noscript>
          <style>{`.${styles.panel}{position:relative;top:auto}`}</style>
        </noscript>
        {/* ---- The pinned panel: the pack (stand-in or the stage) ---- */}
        <div ref={panelRef} className={styles.panel} aria-hidden>
          {panel === undefined ? (
            <div className={styles.stage}>
              {/* eslint-disable-next-line @next/next/no-img-element -- a stand-in for the 3D pack, sized by CSS */}
              <img
                src={pack.image}
                alt=""
                className={styles.pack}
                data-shape={data.shape}
                draggable={false}
              />
            </div>
          ) : (
            panel
          )}
          <div className={styles.mini}>
            <p className="truncate text-sm font-semibold text-white">
              {miniText}
            </p>
          </div>
        </div>

        {/* ---- The chapters ---- */}
        <div className={`${styles.chapters} px-fluid`}>
          {/* Stop 1: the back (the front, for a pack that never turns) */}
          <section
            className={`${styles.backStop} pb-6 pt-3`}
            aria-labelledby="flow-pack-name"
          >
            <div data-chapter className="flex flex-col gap-3">
              <button
                type="button"
                onClick={requestLeave}
                className="-ml-1 inline-flex min-h-11 w-fit items-center gap-1.5 rounded-lg px-1 text-[13px] font-medium text-neutral-400 outline-none transition-colors hover:text-white focus-visible:ring-2 focus-visible:ring-white/40"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden />
                All {noun}s
              </button>
              <h1
                id="flow-pack-name"
                ref={headingRef}
                tabIndex={-1}
                className="font-heading text-[clamp(2rem,6vw,4rem)] font-bold leading-none tracking-[-0.03em] text-white outline-none"
              >
                {pack.name}
              </h1>
              <dl className="flex flex-wrap gap-x-6 gap-y-2">
                {facts.map((fact) => (
                  <div key={fact.label} className="flex flex-col gap-0.5">
                    <dt className="text-[11px] font-semibold uppercase tracking-[0.06em] text-neutral-500">
                      {fact.label}
                    </dt>
                    <dd className="flex items-center gap-1.5 text-sm font-semibold text-white">
                      {fact.label === 'Category' && (
                        <CategoryIcon
                          src={pack.icon}
                          size={20}
                          className="h-5 w-5"
                        />
                      )}
                      {fact.value}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>

            {/* Phone: the buyback pill and the guest demo under the pack. */}
            <div
              data-chapter
              className="flex flex-col items-start gap-3 lg:hidden"
            >
              {!tickets && (
                <span className="inline-flex items-center gap-1 rounded-full bg-buyback px-3 py-1.5 text-xs font-bold text-white">
                  {buy.buybackPercent}% instant buyback
                  <Info className="h-3 w-3 opacity-80" aria-hidden />
                </span>
              )}
              {buy.showDemo && (
                <a
                  href={buy.demoHref}
                  className="inline-flex min-h-11 items-center gap-2 rounded-full bg-white/[0.06] px-4 text-sm font-semibold text-white ring-1 ring-white/10 transition-colors hover:bg-white/10"
                >
                  Try a free demo spin
                </a>
              )}
            </div>

            {/* Desktop: the buyback badge and the configurator. */}
            <div data-chapter className="mt-6 hidden flex-col gap-4 lg:flex">
              {!tickets && (
                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-buyback px-3 py-1.5 text-xs font-bold text-white">
                  {buy.buybackPercent}% instant buyback
                  <Info className="h-3 w-3 opacity-80" aria-hidden />
                </span>
              )}
              <div className="max-w-[30rem] rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10">
                <div className="flex flex-col overflow-hidden rounded-[calc(2rem-0.375rem)] bg-neutral-950 shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)]">
                  <PackBuyControls model={buy} variant="panel" />
                </div>
              </div>
            </div>
          </section>

          {/* Desktop: the compact buy bar once stop 1 has gone by. */}
          <div className={`${styles.compact} hidden lg:block`}>
            <div className="rounded-full bg-neutral-950/90 py-2 pl-5 pr-2 ring-1 ring-white/10 backdrop-blur">
              <PackBuyControls model={buy} variant="compact" />
            </div>
          </div>

          {/* Stops 2..4: the tier walk */}
          <div ref={walkRef} className={`${styles.walk} py-16`} data-chapter>
            <PackTierWalk
              pack={pack}
              tiers={data.tiers}
              onOpenCard={overlay.open}
            />
          </div>

          {/* The last pinned stop: Pull Odds (no odds: no board, no stop) */}
          <div ref={oddsRef} className="pb-16" data-chapter>
            <PackPullOdds pack={pack} tiers={data.tiers} counts bare />
          </div>
        </div>
      </div>

      {/* ---- Past the pin: Recent Pulls, then the closing band ---- */}
      <div className="px-fluid">
        <div data-chapter className="py-14">
          <PackRecentPulls
            pack={pack}
            initial={data.recentPulls}
            onOpenCard={overlay.open}
            bare
          />
        </div>
        <section
          data-chapter
          aria-label={`Open ${pack.name}`}
          className="mb-28 flex flex-col items-start gap-5 border-t border-white/10 py-14 lg:mb-16 lg:flex-row lg:items-center lg:justify-between"
        >
          <p className="font-heading text-[clamp(1.75rem,5vw,3.25rem)] font-bold leading-none tracking-[-0.03em] text-white">
            Open {pack.name} · {rm(buy.priceNum)}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {buy.soldOut ? (
              <Pill variant="secondary" size="lg" disabled>
                {buy.unavailableLabel}
              </Pill>
            ) : (
              <Pill
                variant="primary"
                size="lg"
                onClick={buy.handleGoToReel}
                className="group/open justify-between gap-4 pl-6 pr-2"
              >
                {buy.signedIn ? buy.openLabel : 'Log in to open'}
                <span className="flex items-center gap-2.5 font-heading text-base tabular-nums">
                  {price}
                  <ArrowDisc />
                </span>
              </Pill>
            )}
            <button
              type="button"
              onClick={requestLeave}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-neutral-300 ring-1 ring-white/10 transition-colors hover:text-white"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden />
              Back to all {noun}s
            </button>
          </div>
        </section>
      </div>

      {/* Phone: the buy dock above the tab bar. */}
      <PackBuyControls model={buy} variant="dock" />
      <PackCardOverlay pack={pack} overlay={overlay} />
    </>
  );
}
