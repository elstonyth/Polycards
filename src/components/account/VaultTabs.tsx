import Link from 'next/link';
import { cn } from '@/lib/utils';

const TABS = [
  { href: '/vault', label: 'In vault' },
  { href: '/vault/history', label: 'Pull history' },
] as const;

// The vault's two views as the leaderboard's segmented pill (selected = Paper
// White on Ink). Links, not buttons: each view is its own server-rendered page.
export function VaultTabs({
  current,
}: {
  current: (typeof TABS)[number]['href'];
}) {
  return (
    <nav
      aria-label="Vault views"
      className="mb-4 grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-neutral-900 p-1 sm:max-w-sm"
    >
      {TABS.map((t) => (
        <Link
          key={t.href}
          href={t.href}
          aria-current={t.href === current ? 'page' : undefined}
          className={cn(
            'flex min-h-11 items-center justify-center rounded-full px-2 text-[13px] font-semibold transition-colors sm:text-sm',
            'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
            t.href === current
              ? 'bg-neutral-50 text-neutral-950'
              : 'text-neutral-400 hover:text-white',
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
