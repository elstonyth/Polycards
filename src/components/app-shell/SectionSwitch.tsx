'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';

type Section = { label: string; href: string };

/** The two pages behind the phone bar's Rewards tab. */
export const REWARDS_SECTIONS: readonly Section[] = [
  { label: 'Tasks', href: '/task' },
  { label: 'Ranks', href: '/leaderboard' },
];

/**
 * The switch at the top of a page that shares a phone tab with another page
 * (the phone bar has six tabs for seven destinations). Phones only: the
 * desktop header links every destination directly.
 */
export function SectionSwitch({
  label,
  items,
  className,
}: {
  /** Names the group for screen readers ("Rewards", "Play"). */
  label: string;
  items: readonly Section[];
  className?: string;
}) {
  const pathname = usePathname();
  if (items.length < 2) return null;
  return (
    <nav
      aria-label={label}
      className={cn(
        'flex rounded-full border border-white/10 bg-neutral-900 p-1 lg:hidden',
        className,
      )}
    >
      {items.map((item) => {
        const on =
          pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex h-11 flex-1 items-center justify-center rounded-full text-sm font-semibold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-glacier',
              on
                ? 'bg-neutral-700 text-white'
                : 'text-neutral-400 hover:text-white',
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
