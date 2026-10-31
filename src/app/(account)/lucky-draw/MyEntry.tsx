'use client';

import { useEffect, useState } from 'react';
import { UnavailablePanel } from '@/components/task-ui';
import { cn } from '@/lib/utils';
import { mytClock, mytDate, num } from '@/lib/format';
import { getMyLuckyDraw } from '@/lib/actions/lucky-draw';
import { entryChance, POOL_TITLE } from '@/lib/lucky-draw';
import type { LuckyDrawMine } from '@/lib/data/schemas';
import { mytWhen, PrizeArt } from './PrizeCard';

const REASON: Record<string, string> = {
  task_claim: 'Task reward',
  pack_spin: 'Lucky Pack',
  entry: 'Entered a draw',
  refund: 'Refund',
};

const STATUS = {
  open: { label: 'Open', className: 'bg-neutral-800 text-neutral-200' },
  won: { label: 'Won', className: 'bg-chase text-neutral-950' },
  lost: { label: 'Not won', className: 'bg-neutral-800 text-neutral-400' },
  cancelled: {
    label: 'Cancelled · refunded',
    className: 'bg-neutral-800 text-neutral-400',
  },
} satisfies Record<string, { label: string; className: string }>;

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mt-6 mb-2 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
      {children}
    </h2>
  );
}

/** The pools this account joined, with its chance and how each ended, and its
 *  ticket history (Results is the same record for the whole platform). The
 *  balance is on the page's title row. Read when the tab opens, so a fresh entry
 *  shows. */
export function MyEntry() {
  const [mine, setMine] = useState<LuckyDrawMine | null | 'failed'>(null);

  useEffect(() => {
    let live = true;
    getMyLuckyDraw().then((r) => {
      if (live) setMine(r ?? 'failed');
    });
    return () => {
      live = false;
    };
  }, []);

  if (mine === 'failed') return <UnavailablePanel />;
  if (mine === null) {
    return (
      <div aria-hidden className="space-y-2">
        <div className="h-24 animate-pulse rounded-2xl bg-neutral-900 motion-reduce:animate-none" />
        <div className="h-16 animate-pulse rounded-2xl bg-neutral-900 motion-reduce:animate-none" />
      </div>
    );
  }

  return (
    <div>
      <Heading>Pools you joined</Heading>
      {mine.entries.length === 0 ? (
        <p className="text-sm text-neutral-400">
          You haven&rsquo;t joined a pool yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {mine.entries.map((e) => {
            const status =
              STATUS[e.status as keyof typeof STATUS] ?? STATUS.open;
            const chance = entryChance(e);
            return (
              <li
                key={e.prize_id}
                className="flex items-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 p-3"
              >
                <span className="relative aspect-[5/7] w-10 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] p-0.5">
                  <span className="relative block h-full w-full">
                    {/* An event row with no art takes the gift, not the coins. */}
                    <PrizeArt
                      src={e.image}
                      kind={e.event_id ? 'card' : undefined}
                    />
                  </span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">
                    {e.event_id ? POOL_TITLE : e.title}
                  </p>
                  <p className="mt-0.5 text-[11px] text-neutral-400 tabular-nums">
                    {num(e.my_tickets)}{' '}
                    {e.my_tickets === 1 ? 'ticket' : 'tickets'}
                    {chance && ` · ${chance}`} ·{' '}
                    {e.status === 'open' && 'draws '}
                    {mytWhen(e.draw_at)}
                  </p>
                </div>
                <span
                  className={cn(
                    'shrink-0 rounded-full px-2.5 py-1 text-[11px] font-semibold',
                    status.className,
                  )}
                >
                  {status.label}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <Heading>Ticket history</Heading>
      {mine.history.length === 0 ? (
        <p className="text-sm text-neutral-400">
          No tickets yet — tasks pay them out when you claim.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
          {mine.history.map((h, i) => (
            <li
              key={i}
              className={cn(
                'flex items-center gap-3 px-4 py-2.5',
                i > 0 && 'border-t border-white/5',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm text-neutral-200">
                  {h.reason === 'admin_grant'
                    ? h.delta > 0
                      ? 'Gift from Polycards'
                      : 'Adjusted by Polycards'
                    : (REASON[h.reason] ?? 'Tickets')}
                </p>
                <p className="text-[11px] text-neutral-400">
                  {mytDate(h.created_at)}, {mytClock(h.created_at)} MYT
                </p>
              </div>
              <span
                className={cn(
                  'font-heading shrink-0 text-base tabular-nums',
                  h.delta > 0 ? 'text-white' : 'text-neutral-400',
                )}
              >
                {h.delta > 0 ? '+' : '−'}
                {num(Math.abs(h.delta))}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
