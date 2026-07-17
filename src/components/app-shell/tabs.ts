import {
  CalendarCheck,
  CircleUserRound,
  Home,
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
};

/** The five app destinations, in the boss-specified order (Home center). */
export const TABS: Tab[] = [
  { label: 'Daily', href: '/daily', icon: CalendarCheck },
  { label: 'Ranks', href: '/leaderboard', icon: Trophy },
  { label: 'Home', href: '/', icon: Home },
  { label: 'Vault', href: '/vault', icon: Vault, gated: true },
  {
    label: 'Me',
    href: '/me',
    icon: CircleUserRound,
    gated: true,
    match: [
      '/wallet',
      '/settings',
      '/orders',
      '/transactions',
      '/referrals',
      '/vouchers',
      '/bank-withdrawal',
      '/notifications',
      '/vip',
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
