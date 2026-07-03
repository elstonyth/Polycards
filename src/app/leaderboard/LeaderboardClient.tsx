'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import type { LeaderboardEntry } from '@/lib/data/leaderboard';

const PERIODS = ['This Week', 'All Time'] as const;
type Period = (typeof PERIODS)[number];

const PRIZE_TIERS = [
  { place: '#1', label: '1st Place', reward: 'Grand prize pack + 50,000 pts' },
  { place: '#2', label: '2nd Place', reward: 'Premium pack + 25,000 pts' },
  { place: '#3', label: '3rd Place', reward: 'Premium pack + 10,000 pts' },
  { place: 'TOP 10', label: 'Top 10', reward: 'Exclusive pack + 5,000 pts' },
  { place: 'TOP 100', label: 'Top 100', reward: '1,000 bonus pts' },
];

/** Medal colors for ranks 1–3 (chase gold / silver / bronze), neutral after. */
function medalStyle(rank: number): { bg: string; text: string } {
  if (rank === 1) return { bg: 'bg-chase', text: 'text-neutral-950' };
  if (rank === 2) return { bg: 'bg-neutral-300', text: 'text-neutral-950' };
  if (rank === 3) return { bg: 'bg-amber-700', text: 'text-amber-50' };
  return { bg: 'bg-neutral-800', text: 'text-neutral-400' };
}

export default function LeaderboardClient({
  weekly,
  alltime,
  ownHandle,
}: {
  weekly: LeaderboardEntry[];
  alltime: LeaderboardEntry[];
  ownHandle: string | null;
}) {
  const [period, setPeriod] = useState<Period>('This Week');
  const entries = period === 'All Time' ? alltime : weekly;

  const own =
    ownHandle == null
      ? null
      : (entries.find((e) => e.handle === ownHandle) ?? null);

  return (
    <div className="px-fluid mx-auto w-full max-w-md pt-4 lg:max-w-3xl">
      <div className="flex items-center justify-between">
        <h1 className="font-heading text-3xl text-white">LEADERBOARD</h1>
      </div>

      {/* Period toggle — 90scard's Past / This Week pills. */}
      <div
        role="tablist"
        aria-label="Leaderboard timeframe"
        className="mt-4 grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-neutral-900 p-1"
      >
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={period === p}
            onClick={() => setPeriod(p)}
            className={cn(
              'rounded-full px-3 py-2 text-center text-sm font-semibold transition-colors',
              period === p
                ? 'bg-neutral-50 text-neutral-950'
                : 'text-neutral-400 hover:text-white',
            )}
          >
            {p}
          </button>
        ))}
      </div>

      {/* Prize rail — what the week pays out. */}
      <section aria-label="Weekly prizes" className="mt-4">
        <div className="flex snap-x gap-2 overflow-x-auto pb-1">
          {PRIZE_TIERS.map((tier, i) => (
            <div
              key={tier.place}
              className="flex w-36 shrink-0 snap-start flex-col rounded-2xl border border-white/10 bg-neutral-900 p-3.5"
            >
              <span
                className={cn(
                  'font-heading text-xl',
                  i === 0
                    ? 'text-chase'
                    : i === 1
                      ? 'text-neutral-300'
                      : i === 2
                        ? 'text-amber-700'
                        : 'text-neutral-500',
                )}
              >
                {tier.place}
              </span>
              <span className="mt-1.5 text-[12px] leading-snug text-neutral-300">
                {tier.reward}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-1.5 text-[12px] text-neutral-500">
          Points come from every pack you rip. Weekly board resets Monday 00:00
          (MYT).
        </p>
      </section>

      {/* Standings */}
      <section aria-label="Standings" className="mt-6">
        <h2 className="font-heading text-xl text-white">LIVE STANDINGS</h2>
        {entries.length === 0 ? (
          <div className="mt-3 rounded-2xl border border-white/10 bg-neutral-900 px-6 py-10 text-center">
            <p className="text-sm text-neutral-400">
              No pulls on the board yet — the first rip takes #1.
            </p>
          </div>
        ) : (
          <ol className="mt-3 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
            {entries.map((entry, i) => {
              const medal = medalStyle(entry.rank);
              const isOwn = own != null && entry.handle === ownHandle;
              return (
                <li
                  key={`${entry.rank}-${entry.name}`}
                  className={cn(
                    'flex items-center gap-3 px-4 py-3',
                    i > 0 && 'border-t border-white/5',
                    isOwn && 'bg-white/[0.04]',
                  )}
                >
                  <span
                    className={cn(
                      'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[13px] font-bold',
                      medal.bg,
                      medal.text,
                    )}
                    aria-label={`Rank ${entry.rank}`}
                  >
                    {entry.rank}
                  </span>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={entry.avatar}
                    alt=""
                    width={36}
                    height={36}
                    loading="lazy"
                    className="h-9 w-9 shrink-0 rounded-full object-cover"
                  />
                  <div className="min-w-0 flex-1">
                    {entry.handle ? (
                      <Link
                        href={`/profile/${entry.handle}`}
                        className="block truncate text-sm font-semibold text-white hover:underline"
                      >
                        {entry.name}
                        {isOwn && (
                          <span className="ml-1.5 text-[11px] font-bold text-chase">
                            YOU
                          </span>
                        )}
                      </Link>
                    ) : (
                      <span className="block truncate text-sm font-semibold text-white">
                        {entry.name}
                      </span>
                    )}
                    <p className="truncate text-[12px] text-neutral-500">
                      {entry.volume} · {entry.pulls} pulls
                    </p>
                  </div>
                  <span className="font-heading shrink-0 text-base text-white">
                    {entry.points}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Your-rank card — floats above the tab bar (90scard signature). */}
      {ownHandle != null && (
        <div className="fixed inset-x-4 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.6)] lg:bottom-8">
          {own ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Your rank
                </p>
                <p className="font-heading text-2xl text-white">#{own.rank}</p>
              </div>
              <div className="text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Points
                </p>
                <p className="font-heading text-chase text-2xl">{own.points}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Your rank
                </p>
                <p className="text-sm font-semibold text-white">
                  Not on the board yet
                </p>
              </div>
              <Link
                href="/"
                className="inline-flex h-10 shrink-0 items-center rounded-full bg-neutral-50 px-4 text-[13px] font-semibold text-neutral-950 transition-transform active:scale-[0.98]"
              >
                Rip a pack
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Clearance so the fixed your-rank card never covers the last row. */}
      {ownHandle != null && <div aria-hidden className="h-24" />}
    </div>
  );
}
