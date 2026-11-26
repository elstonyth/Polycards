import {
  CircleUserRound,
  Gamepad2,
  Gift,
  Home,
  ListChecks,
  Ticket,
  Trophy,
  Vault,
  type LucideIcon,
} from 'lucide-react';

/**
 * Fired on window, cancelable, when the Home tab is tapped: a page that
 * handles the tap itself (the home flow takes it back to its row) cancels it,
 * and the tab then neither scrolls nor navigates.
 */
export const HOME_TAP_EVENT = 'home-tab-tap';

/** Fires HOME_TAP_EVENT (a tap on Home or the logo); true when a page took it. */
export const homeTapTaken = (): boolean =>
  !window.dispatchEvent(new Event(HOME_TAP_EVENT, { cancelable: true }));

/**
 * The home flow is the page showing (set while it handles the Home tap): its
 * pack addresses are places on the home page, so Home stays lit on them. The
 * server never sets it, so served pages are unchanged.
 */
let homeFlow = false;
const homeFlowSubs = new Set<() => void>();
export function setHomeFlowShown(on: boolean): void {
  homeFlow = on;
  for (const f of homeFlowSubs) f();
}
export const homeFlowShown = (): boolean => homeFlow;
export function subscribeHomeFlow(f: () => void): () => void {
  homeFlowSubs.add(f);
  return () => homeFlowSubs.delete(f);
}

const PACK_PATH = /^\/slots\/[^/]+\/?$/;

export type Tab = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Extra path prefixes that light this tab up (e.g. account pages → Me). */
  match?: string[];
  /** Requires auth — logged-out clicks open the signup modal instead of navigating. */
  gated?: boolean;
  /** Opens a picker sheet instead of navigating (`href` is only its home). */
  opens?: 'games';
};

/** The seven app destinations (operator 2026-10-25 added Games; 2026-10-30
 *  moved Lucky Draw out of it to a tab of its own, right of Home so Home stays
 *  in the middle). */
export const TABS: Tab[] = [
  { label: 'Task', href: '/task', icon: ListChecks },
  { label: 'Ranks', href: '/leaderboard', icon: Trophy },
  {
    label: 'Games',
    href: '/coin-flip',
    icon: Gamepad2,
    opens: 'games',
    // Lit on every game.
    match: ['/coin-flip', '/vault/coin-flip'],
  },
  { label: 'Home', href: '/', icon: Home },
  // The page is behind login, and says when no draw is on.
  { label: 'Draw', href: '/lucky-draw', icon: Ticket, gated: true },
  { label: 'Vault', href: '/vault', icon: Vault, gated: true },
  {
    label: 'Me',
    href: '/me',
    icon: CircleUserRound,
    gated: true,
    // Every surface reached from the Me hub, or no tab lights up while the
    // user is on it. `isTabActive` compares exact-or-`${p}/` prefix, so
    // '/bank' does NOT swallow '/bank-withdrawal' and both entries are needed.
    match: [
      '/wallet',
      '/settings',
      '/orders',
      '/transactions',
      '/bank',
      '/bank-withdrawal',
      '/notifications',
      '/addresses',
      '/referral',
    ],
  },
];

const tabAt = (href: string): Tab => {
  const tab = TABS.find((t) => t.href === href);
  if (!tab) throw new Error(`no tab at ${href}`);
  return tab;
};

/**
 * The phone bar: six tabs for the same seven destinations, in the header's
 * order. Tasks and Ranks share Rewards (each page carries a SectionSwitch to
 * the other). Play is the Games tab: it opens the game list (owner 2026-11-26),
 * and Lucky Draw has its own tab. The desktop header keeps all seven (TABS).
 */
export const PHONE_TABS: Tab[] = [
  { label: 'Rewards', href: '/task', icon: Gift, match: ['/leaderboard'] },
  { ...tabAt('/coin-flip'), label: 'Play' },
  tabAt('/'),
  tabAt('/lucky-draw'),
  tabAt('/vault'),
  tabAt('/me'),
];

/**
 * Where a nav's lit-tab marker sits: the lit tab's place in `tabs`, or -1 when
 * none is lit.
 */
export function markerIndex(
  tabs: Tab[],
  pathname: string,
  homeFlow = false,
): number {
  return tabs.findIndex((t) => isTabActive(t, pathname, homeFlow));
}

export function isTabActive(
  tab: Tab,
  pathname: string,
  homeFlow = false,
): boolean {
  if (
    tab.href === '/vault' &&
    (pathname === '/vault/coin-flip' ||
      pathname.startsWith('/vault/coin-flip/'))
  )
    return false;
  // The home preview serves "/" under its switch, and the server renders it
  // with the preview's own path: both light Home, so hydration agrees. A pack
  // address lights it only while the home flow shows (never on the server).
  if (tab.href === '/')
    return (
      pathname === '/' ||
      pathname === '/home-preview' ||
      (homeFlow && PACK_PATH.test(pathname))
    );
  if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) return true;
  return (tab.match ?? []).some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}
