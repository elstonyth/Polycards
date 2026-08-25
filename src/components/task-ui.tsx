'use client';

/**
 * The panel vocabulary shared by /task and /referral. Extracted when the
 * Referral tab became its own page (2026-08-25) — both surfaces show the same
 * banner + stat + history shapes, and a second copy would have drifted.
 */
import Image from 'next/image';
import Link from 'next/link';
import { pillVariants } from '@/components/ui/pill';
import { cn } from '@/lib/utils';
import { rm } from '@/lib/format';
import type { ReferralSummary } from '@/lib/data/schemas';

export const fromCents = (cents: number): string => rm(cents / 100);

// Same rendering as the admin console: up to 2 decimals, trailing zeros
// trimmed — 50→"0.5%", 115→"1.15%", 200→"2%" (review 2026-08-25 finding 5).
export const pct = (bp: number): string =>
  `${(bp / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

// The hero band. A 21:9 art plate with the subject on the RIGHT and dark
// negative space on the left, so the heading sits over empty black and stays
// legible without a scrim fighting the art. Decorative only — every banner is
// aria-hidden and the heading it carries is real text, never baked into the
// image.
export function TabBanner({
  src,
  title,
  sub,
}: {
  src: string;
  title: string;
  sub: string;
}) {
  return (
    <div className="relative mb-4 overflow-hidden rounded-2xl border border-white/10 bg-neutral-950">
      <Image
        src={src}
        alt=""
        aria-hidden
        width={1600}
        height={686}
        priority={false}
        className="pointer-events-none h-28 w-full object-cover object-right select-none sm:h-32"
      />
      {/* Left-to-right fade: guarantees the copy's contrast even if the art
          ever changes, without dimming the subject on the right. */}
      <div className="absolute inset-0 bg-gradient-to-r from-neutral-950 via-neutral-950/80 to-transparent" />
      <div className="absolute inset-0 flex flex-col justify-center px-4">
        <p className="font-heading text-xl leading-none text-white sm:text-2xl">
          {title}
        </p>
        <p className="mt-1.5 max-w-[26ch] text-[11px] leading-snug text-neutral-400 sm:text-xs">
          {sub}
        </p>
      </div>
    </div>
  );
}

export function Panel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-2xl border border-white/10 bg-white/[0.03] p-4',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  help,
}: {
  label: string;
  value: string;
  /** Optional explainer rendered as a HelpTip beside the label. */
  help?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl bg-neutral-900 p-3">
      <p className="flex items-center gap-1 text-[11px] tracking-wide text-white/40 uppercase">
        {label}
        {help}
      </p>
      <p className="font-heading mt-1 text-lg text-white">{value}</p>
    </div>
  );
}

// Rendered when a payload is null but the customer IS logged in — the backend
// hiccuped, and telling a logged-in customer to "sign in" reads as a lost
// session (review 2026-08-25 finding 7).
export function UnavailablePanel() {
  return (
    <Panel className="text-center">
      <p className="text-sm leading-relaxed text-neutral-400">
        Couldn&rsquo;t load this right now — give it a second and refresh.
      </p>
    </Panel>
  );
}

export function SignInPrompt({ what }: { what: string }) {
  return (
    <Panel className="text-center">
      <p className="text-sm leading-relaxed text-neutral-400">
        Sign in to see {what}.
      </p>
      <Link
        href="/settings"
        className={cn(pillVariants({ size: 'sm' }), 'mt-4')}
      >
        Sign in
      </Link>
    </Panel>
  );
}

export function HistoryList({
  rows,
  empty,
}: {
  rows: ReferralSummary['history'];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="py-3 text-center text-sm text-neutral-500">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-white/5">
      {rows.map((row) => (
        <li
          key={`${row.week_start}-${row.status}-${row.amount_cents}`}
          className="flex items-center justify-between py-2.5 text-sm"
        >
          <div>
            <p className="text-white">{fromCents(row.amount_cents)}</p>
            <p className="text-xs text-white/40">
              Week of {row.week_start} · {pct(row.rate_bp)} of{' '}
              {fromCents(row.basis_cents)}
            </p>
          </div>
          <span
            className={cn(
              'rounded-full px-2.5 py-0.5 text-[11px] font-semibold uppercase',
              row.status === 'paid' && 'bg-emerald-500/15 text-emerald-300',
              row.status === 'pending' && 'bg-amber-500/15 text-amber-300',
              row.status === 'voided' && 'bg-white/5 text-white/40',
            )}
          >
            {row.status}
          </span>
        </li>
      ))}
    </ul>
  );
}
