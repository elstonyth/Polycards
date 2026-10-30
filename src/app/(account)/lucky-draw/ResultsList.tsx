'use client';

import { useEffect, useState, useTransition } from 'react';
import { Pill } from '@/components/ui/pill';
import { UnavailablePanel } from '@/components/task-ui';
import { num } from '@/lib/format';
import { getLuckyDrawResults } from '@/lib/actions/lucky-draw';
import { eventRowId } from '@/lib/lucky-draw';
import type { LuckyDrawResult } from '@/lib/data/schemas';
import { mytWhen, PersonChip, PrizeArt } from './PrizeCard';

type Loaded = { rows: LuckyDrawResult[]; next: string | null };

/** Every past draw across events, newest first (spec §9), a page at a time
 *  through `next_before`: one row per one-winner event, one per old prize. Read
 *  when the tab opens, so a fresh draw shows. */
export function ResultsList({
  onOpen,
  onOpenEvent,
}: {
  onOpen: (prizeId: string) => void;
  onOpenEvent: (eventId: string, eventName: string) => void;
}) {
  const [loaded, setLoaded] = useState<Loaded | null | 'failed'>(null);
  const [more, startMore] = useTransition();

  useEffect(() => {
    let live = true;
    getLuckyDrawResults().then((r) => {
      if (live)
        setLoaded(r ? { rows: r.results, next: r.next_before } : 'failed');
    });
    return () => {
      live = false;
    };
  }, []);

  if (loaded === 'failed') return <UnavailablePanel />;
  if (loaded === null) {
    return (
      <ul aria-hidden className="space-y-2">
        {[0, 1, 2].map((i) => (
          <li
            key={i}
            className="h-20 animate-pulse rounded-2xl bg-neutral-900 motion-reduce:animate-none"
          />
        ))}
      </ul>
    );
  }
  if (loaded.rows.length === 0) {
    return (
      <p className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-6 text-center text-sm text-neutral-400">
        No draws yet — results show here after each draw.
      </p>
    );
  }

  const loadMore = () =>
    startMore(async () => {
      if (!loaded.next) return;
      const r = await getLuckyDrawResults(loaded.next);
      if (r) {
        setLoaded({
          rows: [...loaded.rows, ...r.results],
          next: r.next_before,
        });
      }
    });

  return (
    <div>
      <ul className="space-y-2">
        {loaded.rows.map((r) => {
          const eventId = eventRowId(r);
          const title = (eventId && r.event_name) || r.title;
          return (
            <li key={eventId ?? r.prize_id}>
              <button
                type="button"
                onClick={() =>
                  eventId ? onOpenEvent(eventId, title) : onOpen(r.prize_id)
                }
                className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-neutral-900 p-3 text-left transition-colors outline-none hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-white/40"
              >
                <span className="relative aspect-[5/7] w-11 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/[0.04] p-0.5">
                  <span className="relative block h-full w-full">
                    <PrizeArt src={r.image} />
                  </span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-white">
                    {title}
                  </span>
                  {r.winner ? (
                    <PersonChip
                      person={r.winner}
                      size={20}
                      className="mt-1 text-xs text-neutral-300"
                    />
                  ) : (
                    <span className="mt-1 block text-xs text-neutral-400">
                      No entries
                    </span>
                  )}
                  <span className="mt-1 block text-[11px] text-neutral-400 tabular-nums">
                    {eventId && r.prize_count != null
                      ? `${num(r.prize_count)} ${r.prize_count === 1 ? 'prize' : 'prizes'} · `
                      : ''}
                    {r.winner
                      ? `${num(r.winner_tickets)} of ${num(r.total_tickets)} tickets · `
                      : ''}
                    {num(r.entrant_count)}{' '}
                    {r.entrant_count === 1 ? 'entrant' : 'entrants'} ·{' '}
                    {mytWhen(r.drawn_at)}
                  </span>
                </span>
                <span aria-hidden className="shrink-0 text-neutral-400">
                  &rarr;
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {loaded.next && (
        <div className="mt-4 flex justify-center">
          <Pill variant="secondary" disabled={more} onClick={loadMore}>
            {more ? 'Loading…' : 'Show older draws'}
          </Pill>
        </div>
      )}
    </div>
  );
}
