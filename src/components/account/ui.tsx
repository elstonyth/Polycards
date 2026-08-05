import { type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';

/**
 * The one text-input style for the account cluster (settings, addresses,
 * orders, prize withdrawal). The focus ring is copied verbatim from
 * AuthForm.tsx:360: `focus:border-white/25` alone is a 1px 25%-alpha edge on
 * a near-black field, nowhere near the 3:1 WCAG 2.4.11 needs, so the visible
 * indicator has to be the ring.
 */
export const INPUT_CLASS =
  'h-11 w-full rounded-xl border border-white/10 bg-white/[0.03] px-3 text-sm text-white placeholder:text-white/40 focus:border-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-offset-0';

export function AccountHeader({
  title,
  sub,
}: {
  title: string;
  // ReactNode, not string: the (suspended 2026-07-29) /referrals page
  // highlighted part of its subtitle; kept for the revert.
  sub?: ReactNode;
}) {
  return (
    <header className="mb-6">
      <h1 className="font-heading text-2xl font-bold tracking-tight text-white sm:text-3xl">
        {title}
      </h1>
      {sub && <p className="mt-1.5 text-sm text-white/50">{sub}</p>}
    </header>
  );
}

export function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-2xl border border-white/10 bg-white/[0.03] p-5 sm:p-6 ${className}`}
    >
      {children}
    </div>
  );
}

export function StatCards({
  items,
}: {
  items: { label: string; value: string; sub?: string }[];
}) {
  return (
    // Phone: one full-width row per stat (label left, value right). A 2-col
    // grid of cards only fits ~140px of value, so a real balance wrapped after
    // the "RM" — money must never break across lines. Cards resume at sm,
    // where the column is wide enough to hold the longest figure.
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 sm:gap-3 lg:grid-cols-4">
      {items.map((s) => (
        <div
          key={s.label}
          className="flex items-center justify-between gap-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 sm:block sm:p-4"
        >
          <p className="text-[11px] uppercase tracking-wide text-white/60">
            {s.label}
          </p>
          <div className="text-right sm:text-left">
            <p className="font-heading whitespace-nowrap text-xl font-bold tabular-nums text-white sm:mt-1 sm:text-2xl">
              {s.value}
            </p>
            {s.sub && (
              <p className="mt-0.5 text-[12px] text-white/50">{s.sub}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

const TONES = {
  green: 'bg-buyback/15 text-buyback-fg',
  amber: 'bg-amber-500/15 text-amber-400',
  sky: 'bg-sky-500/15 text-sky-400',
  neutral: 'bg-white/10 text-white/70',
} as const;

export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: keyof typeof TONES;
}) {
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Prev/next pagination for the account list pages (?page=N URLs, server
 * components — plain links, no client JS). Hidden entirely on a single page
 * so short lists don't grow dead chrome.
 */
export function Pager({
  page,
  hasMore,
  basePath,
}: {
  page: number;
  hasMore: boolean;
  basePath: string;
}) {
  if (page <= 1 && !hasMore) return null;
  const href = (p: number) => (p <= 1 ? basePath : `${basePath}?page=${p}`);
  const linkClasses = cn(pillVariants({ variant: 'ghost', size: 'sm' }));
  const disabledClasses = cn(
    pillVariants({ variant: 'ghost', size: 'sm' }),
    'pointer-events-none opacity-40',
  );
  return (
    <nav
      aria-label="Pagination"
      className="mt-5 flex items-center justify-between"
    >
      {page > 1 ? (
        <Link href={href(page - 1)} className={linkClasses}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Previous
        </Link>
      ) : (
        <span aria-disabled className={disabledClasses}>
          <ChevronLeft className="h-4 w-4" aria-hidden />
          Previous
        </span>
      )}
      <span className="text-[12px] font-semibold uppercase tracking-wide text-white/50">
        Page {page}
      </span>
      {hasMore ? (
        <Link href={href(page + 1)} className={linkClasses}>
          Next
          <ChevronRight className="h-4 w-4" aria-hidden />
        </Link>
      ) : (
        <span aria-disabled className={disabledClasses}>
          Next
          <ChevronRight className="h-4 w-4" aria-hidden />
        </span>
      )}
    </nav>
  );
}
