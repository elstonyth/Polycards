import {
  CircleUserRound,
  Gamepad2,
  Home,
  ListChecks,
  Trophy,
  Vault,
  type LucideIcon,
} from 'lucide-react';

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

/** The six app destinations (operator 2026-10-25 added Games as the sixth). */
export const TABS: Tab[] = [
  { label: 'Task', href: '/task', icon: ListChecks },
  { label: 'Ranks', href: '/leaderboard', icon: Trophy },
  {
    label: 'Games',
    href: '/lucky-draw',
    icon: Gamepad2,
    opens: 'games',
    // Lit on every game; Coin Flip joins when it ships.
    match: ['/coin-flip'],
  },
  { label: 'Home', href: '/', icon: Home },
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

export function isTabActive(tab: Tab, pathname: string): boolean {
  if (tab.href === '/') return pathname === '/';
  if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) return true;
  return (tab.match ?? []).some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}
