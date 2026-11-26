'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { PullGapsChart } from '@/components/PullGapsChart';
import { useShelfCategory } from '@/components/home/ShelfCategory';
import type { RecentFeed } from '@/lib/data/packs';
import { POLY_CATEGORY } from '@/lib/packs-data';
import { RARITY_ORDER } from '@/lib/rarity';
import { useModalA11y } from '@/lib/use-modal-a11y';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useLiveRecentPulls } from '@/lib/use-recent-pulls';
import {
  DRAWER_TABS,
  feedRarity,
  nextStack,
  settleStack,
  showsChart,
  stackCards,
  startStack,
  tabsBehind,
  DRAWER_MEDIA,
  type DrawerSize,
  type DrawerTab,
} from './drawer-model';
import { JustPulledView } from './JustPulledView';

/** The leave animation's length (drawer.module.css jp-leave), and a margin. */
const LEAVE_MS = 520;

/** A pack is focused and the visitor has not gone past its details: the
 *  focused pack polls its own pulls, so the drawer's poll waits (the stage's
 *  words: data-focus-on on its wrap, data-flow-past on the flow root). */
export function focusHolds(): boolean {
  return (
    !!document.querySelector('[data-focus-on]') &&
    !document.querySelector('[data-flow-past]')
  );
}

export function subscribeFocusHold(onChange: () => void) {
  const watch = new MutationObserver(onChange);
  watch.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['data-focus-on', 'data-flow-past'],
  });
  return () => watch.disconnect();
}

/** The drawer's size as far as its tab count goes ('short' keeps the phone's). */
function drawerSize(): DrawerSize {
  if (window.matchMedia(DRAWER_MEDIA.desktop).matches) return 'desktop';
  return window.matchMedia(DRAWER_MEDIA.tiny).matches ? 'tiny' : 'phone';
}

function subscribeSize(onChange: () => void) {
  const ms = Object.values(DRAWER_MEDIA).map((q) => window.matchMedia(q));
  for (const m of ms) m.addEventListener('change', onChange);
  return () => {
    for (const m of ms) m.removeEventListener('change', onChange);
  };
}

/**
 * The Stats chart, in a bottom sheet over the page (the house pattern:
 * RankRewardSheet). Not in the drawer's place: the chart is several screens
 * tall, and the section's height is what the flow's scroll is measured by
 * (owner 2026-11-26: opened in place, it ran below the screen and one swipe
 * passed all of it). A dialog keeps its own scrolling; the flow leaves it be.
 */
function StatsSheet({
  onClose,
  category,
  refreshKey,
}: {
  onClose: () => void;
  category?: string;
  refreshKey: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useModalA11y(panelRef, true, onClose);
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center bg-black/60 sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="jp-stats-heading"
        tabIndex={-1}
        data-jp-stats=""
        className="max-h-[85svh] w-full overflow-y-auto overscroll-contain [scrollbar-color:var(--color-neutral-700)_transparent] [scrollbar-width:thin] rounded-t-3xl border-t border-white/10 bg-neutral-900 px-4 pb-[max(env(safe-area-inset-bottom),1rem)] outline-none sm:max-w-xl sm:rounded-3xl sm:border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* The sheet has no top padding of its own: the rows would show
            through it above this bar. */}
        <div className="sticky top-0 z-10 -mx-4 mb-3 flex items-center justify-between border-b border-white/[0.08] bg-neutral-900 px-4 pt-2 pb-1">
          <h2 id="jp-stats-heading" className="font-heading text-lg text-white">
            Pull stats
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close stats"
            className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-neutral-400 outline-none transition-colors hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        </div>
        {/* Opens on Immortal; refetches when a counter moves (a new pull). */}
        <PullGapsChart category={category} refreshKey={refreshKey} bare />
      </div>
    </div>,
    document.body,
  );
}

/**
 * The live drawer (lazy chunk "jp-drawer", loaded by JustPulledShell). It
 * reads the same live feed as today's panel (useLiveRecentPulls: the same
 * endpoint and interval, the Poly feed following the shelf's tab) and keeps
 * the stack in drawer-model.ts: a new pull becomes the front card by itself,
 * a tier tab refills the drawer, Stats opens today's chart in a sheet.
 * Nothing here reads the scroll.
 */
export function JustPulledDrawer({
  initial,
  initialTab,
}: {
  initial: RecentFeed;
  /** A tab pressed before this code arrived (JustPulledShell). */
  initialTab?: string;
}) {
  const { active } = useShelfCategory();
  const [tab, setTab] = useState<DrawerTab>('All');
  const [statsOpen, setStatsOpen] = useState(false);
  // The first render reads the scope the server's feed belongs to (All, the
  // whole store); the shelf's category and an early tab apply right after,
  // so the feed sees a change of scope: it fetches at once and dims the
  // drawer until the new pulls land, as today's panel does.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setMounted(true);
      const early = DRAWER_TABS.find((t) => t === initialTab);
      if (early && showsChart(early)) setStatsOpen(true);
      else if (early) setTab(early);
    });
    return () => cancelAnimationFrame(id);
  }, [initialTab]);
  const size = useSyncExternalStore<DrawerSize>(
    subscribeSize,
    drawerSize,
    () => 'phone',
  );
  // The plain list under reduced motion: no limit behind the front, so
  // nothing leaves.
  const behind = usePrefersReducedMotion() ? Infinity : tabsBehind(size);
  const held = useSyncExternalStore(
    subscribeFocusHold,
    focusHolds,
    () => false,
  );
  const { pulls, drought, pending, shownScope, shownCategory } =
    useLiveRecentPulls(
      initial,
      undefined,
      feedRarity(tab),
      mounted && active === POLY_CATEGORY ? POLY_CATEGORY : undefined,
      { paused: held },
    );
  const [stack, setStack] = useState(() => startStack(shownScope, pulls));
  // A new feed moves the stack in the same render (state adjusted while
  // rendering, not in an effect, so no frame shows the old stack on new rows).
  if (stack.items !== pulls || stack.scope !== shownScope)
    setStack(nextStack(stack, shownScope, pulls, behind));

  const leavingId = stack.leaving?.id;
  useEffect(() => {
    if (!leavingId) return;
    const t = setTimeout(() => setStack(settleStack), LEAVE_MS);
    return () => clearTimeout(t);
  }, [leavingId]);

  const [loaded] = useState(initial.drought);
  const moved = new Set(
    RARITY_ORDER.filter((r) => drought[r] != null && drought[r] !== loaded[r]),
  );

  const choose = (next: DrawerTab) => {
    // Stats is not a filter: the drawer stays as it is under the sheet.
    if (showsChart(next)) setStatsOpen(true);
    else setTab(next);
  };

  return (
    <>
      <JustPulledView
        cards={stackCards(stack, behind)}
        stackKey={`${stack.scope}#${stack.gen}`}
        drought={drought}
        noun={shownCategory ? 'capsule' : 'pack'}
        tab={tab}
        onTab={choose}
        pending={pending}
        moved={moved}
        listForm={behind === Infinity}
      />
      {statsOpen && (
        <StatsSheet
          onClose={() => setStatsOpen(false)}
          category={shownCategory}
          refreshKey={JSON.stringify(drought)}
        />
      )}
    </>
  );
}
