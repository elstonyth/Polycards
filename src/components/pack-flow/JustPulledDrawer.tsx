'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { PullGapsChart } from '@/components/PullGapsChart';
import { useShelfCategory } from '@/components/home/ShelfCategory';
import type { RecentFeed } from '@/lib/data/packs';
import { POLY_CATEGORY } from '@/lib/packs-data';
import { RARITY_ORDER } from '@/lib/rarity';
import { usePrefersReducedMotion } from '@/lib/use-reveal';
import { useLiveRecentPulls } from '@/lib/use-recent-pulls';
import {
  DRAWER_TABS,
  feedRarity,
  nextStack,
  refillStack,
  settleStack,
  showsChart,
  stackCards,
  startStack,
  tabsBehind,
  type DrawerTab,
} from './drawer-model';
import { JustPulledView } from './JustPulledView';

/** The leave animation's length (drawer.module.css jp-leave), and a margin. */
const LEAVE_MS = 520;
const DESKTOP = '(min-width: 1024px)';

function subscribeDesktop(onChange: () => void) {
  const m = window.matchMedia(DESKTOP);
  m.addEventListener('change', onChange);
  return () => m.removeEventListener('change', onChange);
}

/**
 * The live drawer (lazy chunk "jp-drawer", loaded by JustPulledShell). It
 * reads the same live feed as today's panel (useLiveRecentPulls: the same
 * endpoint and interval, the Poly feed following the shelf's tab) and keeps
 * the stack in drawer-model.ts: a new pull becomes the front card by itself,
 * a tier tab refills the drawer, Stats puts today's chart in its place.
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
  // The first render reads the scope the server's feed belongs to (All, the
  // whole store); the shelf's category and an early tab apply right after,
  // so the feed sees a change of scope: it fetches at once and dims the
  // drawer until the new pulls land, as today's panel does.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      setMounted(true);
      const early = DRAWER_TABS.find((t) => t === initialTab);
      if (early) setTab(early);
    });
    return () => cancelAnimationFrame(id);
  }, [initialTab]);
  const desktop = useSyncExternalStore(
    subscribeDesktop,
    () => window.matchMedia(DESKTOP).matches,
    () => false,
  );
  // The plain list under reduced motion: no limit behind the front, so
  // nothing leaves.
  const behind = usePrefersReducedMotion() ? Infinity : tabsBehind(desktop);
  const { pulls, drought, pending, shownScope, shownCategory } =
    useLiveRecentPulls(
      initial,
      undefined,
      feedRarity(tab),
      mounted && active === POLY_CATEGORY ? POLY_CATEGORY : undefined,
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
    if (next === tab) return;
    // Back from Stats to the same feed: the drawer steps in again. To another
    // tier it refills when that tier's pulls land.
    if (showsChart(tab) && feedRarity(next) === feedRarity(tab))
      setStack((s) => refillStack(s, behind));
    setTab(next);
  };

  return (
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
      chart={
        showsChart(tab) ? (
          // Opens on Immortal; refetches when a counter moves (a new pull).
          <PullGapsChart
            category={shownCategory}
            refreshKey={JSON.stringify(drought)}
          />
        ) : null
      }
    />
  );
}
