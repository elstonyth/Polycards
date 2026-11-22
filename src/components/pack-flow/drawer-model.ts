/**
 * The Just Pulled drawer as data: which
 * pulls stand in the stack, where each one stands, and what a new feed does
 * to it. Pure: no React, no DOM. The drawer's markup reads the result and its
 * CSS draws it (drawer.module.css).
 *
 * The stack is the feed in its own order, newest first: index 0 is the front
 * card, the next `behind` pulls show only their tabs, and the rest wait out
 * of sight. Scrolling never changes it; only the feed does.
 */

import { TOP_RARITIES } from '@/lib/rarity';
import type { Rarity } from '@/lib/packs-data';

/** The filter row: All, the chase tiers, then the Stats chart (as PullHistory). */
export type DrawerTab = 'All' | Rarity | 'Stats';
export const DRAWER_TABS: readonly DrawerTab[] = [
  'All',
  ...TOP_RARITIES,
  'Stats',
];

/** The tier the feed is read for: none on All and on Stats. */
export function feedRarity(tab: DrawerTab): Rarity | null {
  return tab === 'All' || tab === 'Stats' ? null : tab;
}

/** Stats puts the chart where the drawer stands. */
export function showsChart(tab: DrawerTab): boolean {
  return tab === 'Stats';
}

/** PullHistory's empty lines, word for word. */
export function emptyLine(tab: DrawerTab, noun: 'pack' | 'capsule'): string {
  return tab === 'All' || tab === 'Stats'
    ? `No pulls yet — be the first to open a ${noun}.`
    : `No ${tab} pulls yet — the next rip could be the one.`;
}

/** The drawer's size in CSS px (drawer.module.css carries the same numbers):
 *  a card, and how far each tab behind it shows above it. */
export const DRAWER_GEOMETRY = {
  phone: { cardH: 212, tabH: 38, behind: 2 },
  /** Phones up to 720 px tall: the section still fits the panel. */
  short: { cardH: 176, tabH: 34, behind: 2 },
  /** Phones up to 600 px tall: one tab behind. */
  tiny: { cardH: 160, tabH: 34, behind: 1 },
  desktop: { cardH: 316, tabH: 50, behind: 3 },
} as const;

export type DrawerSize = keyof typeof DRAWER_GEOMETRY;

/** drawer.module.css's media queries for the sizes whose tab count differs. */
export const DRAWER_MEDIA = {
  desktop: '(min-width: 1024px)',
  tiny: '(max-width: 1023px) and (max-height: 600px)',
} as const;

/** Tabs shown behind the front card: 2 on a phone, 1 on the shortest
 *  phones, 3 on desktop. */
export function tabsBehind(size: DrawerSize): number {
  return DRAWER_GEOMETRY[size].behind;
}

export type DrawerStack<T extends { id: string }> = {
  /** The feed scope the pulls belong to (useLiveRecentPulls' shownScope). */
  scope: string;
  /** Newest first, as the feed sent them. */
  items: readonly T[];
  /** Pulls that dropped in with the last change. */
  arrived: readonly string[];
  /** The tab on its way out after an arrival, until settleStack. */
  leaving: T | null;
  /** Counts refills: the markup re-keys the stack on it, so a refill steps in. */
  gen: number;
};

export type StackCard<T> = {
  item: T;
  /** Place in the stack: 0 is the front card, 1 the first tab, and so on. */
  d: number;
  arrive: boolean;
  leave: boolean;
};

export function startStack<T extends { id: string }>(
  scope: string,
  items: readonly T[],
): DrawerStack<T> {
  return { scope, items, arrived: [], leaving: null, gen: 0 };
}

const ids = <T extends { id: string }>(items: readonly T[]) =>
  items.map((i) => i.id);

/** The same pulls step in again from the front (a new scope, or the drawer
 *  coming back from Stats). */
export function refillStack<T extends { id: string }>(
  prev: DrawerStack<T>,
  behind: number,
  scope = prev.scope,
  items = prev.items,
): DrawerStack<T> {
  return {
    scope,
    items,
    arrived: ids(items.slice(0, behind + 1)),
    leaving: null,
    gen: prev.gen + 1,
  };
}

/**
 * What a new feed does to the stack. A new pull arrives at the front: it
 * drops in, the cards before it step back one place, and the tab pushed out
 * of view leaves (so a phone never draws more than the front card, its tabs
 * and one card in motion). A new scope, a feed without the old front card,
 * or two or more new pulls at once refill it.
 * `behind` Infinity is the plain list: nothing leaves.
 */
export function nextStack<T extends { id: string }>(
  prev: DrawerStack<T>,
  scope: string,
  items: readonly T[],
  behind: number,
): DrawerStack<T> {
  if (scope !== prev.scope) return refillStack(prev, behind, scope, items);
  const was = ids(prev.items);
  const now = ids(items);
  if (was.length === now.length && was.every((id, i) => id === now[i]))
    return { ...prev, items };
  const k = was.length === 0 ? -1 : now.indexOf(was[0]!);
  // Two or more at once would push more shown cards out than one can leave
  // in view, so they refill instead.
  if (k < 0 || k > Math.min(1, behind))
    return refillStack(prev, behind, scope, items);
  if (k === 0) return { ...prev, items, arrived: [] };
  const shown = new Set(now.slice(0, behind + 1));
  const out = Number.isFinite(behind)
    ? prev.items.slice(0, behind + 1).find((i) => !shown.has(i.id))
    : undefined;
  return {
    scope,
    items,
    arrived: now.slice(0, k),
    leaving: out ?? null,
    gen: prev.gen,
  };
}

/** The leaving card has gone. */
export function settleStack<T extends { id: string }>(
  prev: DrawerStack<T>,
): DrawerStack<T> {
  return prev.leaving ? { ...prev, leaving: null } : prev;
}

/** Every pull with its place, in feed order; a leaving card holds the last
 *  tab's place while it goes, and is drawn even if the feed has dropped it. */
export function stackCards<T extends { id: string }>(
  stack: DrawerStack<T>,
  behind: number,
): StackCard<T>[] {
  const leaveId = stack.leaving?.id;
  const cards = stack.items.map((item, d) =>
    item.id === leaveId
      ? { item, d: behind, arrive: false, leave: true }
      : { item, d, arrive: stack.arrived.includes(item.id), leave: false },
  );
  if (stack.leaving && !stack.items.some((i) => i.id === leaveId))
    cards.push({ item: stack.leaving, d: behind, arrive: false, leave: true });
  return cards;
}
