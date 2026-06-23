'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import {
  useInView,
  usePrefersReducedMotion,
  staggerDelay,
} from '@/lib/use-reveal';
import {
  MOCK_LEADERBOARD,
  type LeaderboardEntry,
} from '@/lib/data/leaderboard';

function Avatar({ src, name }: { src: string; name: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={name}
      width={32}
      height={32}
      loading="lazy"
      className="h-8 w-8 shrink-0 rounded-full object-cover"
    />
  );
}

export default function LeaderboardSection({
  showHeading = true,
  entries = MOCK_LEADERBOARD,
  live = false,
}: {
  showHeading?: boolean;
  /** Leaderboard rows; defaults to the static mock board. */
  entries?: LeaderboardEntry[];
  /** When set, fetch the live weekly board on mount and swap it in (used on the
   *  static homepage so the teaser is live without making the page dynamic).
   *  Leave false when `entries` is already supplied live (e.g. /leaderboard). */
  live?: boolean;
}) {
  // Rows stagger-fade-up when the leaderboard scrolls into view (the "leaderboard
  // goes in" animation). Fires once; respects prefers-reduced-motion.
  const [ref, shown] = useInView<HTMLDivElement>();
  const reduced = usePrefersReducedMotion();
  const show = shown || reduced;

  // Live teaser: poll the same-origin route once on mount (a direct :9000 call
  // is CORS-blocked) and swap the mock board for the live one; keep the current
  // rows on error/empty so it never blanks.
  const [rows, setRows] = useState<LeaderboardEntry[]>(entries);
  useEffect(() => {
    if (!live) return;
    let active = true;
    fetch('/api/leaderboard', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && Array.isArray(d?.entries) && d.entries.length > 0) {
          setRows(d.entries);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [live]);

  return (
    <div ref={ref} className="mt-10 sm:mt-14">
      {/* Header — shown on the homepage section; hidden on the /leaderboard route
          (which has its own podium/tabs), matching the live site. */}
      {showHeading && (
        <div className="mb-4 flex items-baseline justify-between sm:mb-5">
          <h2 className="font-heading bg-gradient-to-b from-white via-white/80 to-white/30 bg-clip-text text-2xl font-bold tracking-tight text-transparent">
            Weekly Leaderboard
          </h2>
          <a
            href="/leaderboard?tab=prizes"
            className="text-[12px] font-medium text-white/50 transition-colors hover:text-white/60"
          >
            View prizes →
          </a>
        </div>
      )}

      {/* Card */}
      <div className="overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900">
        {/* Mobile list */}
        <div className="block divide-y divide-neutral-800 sm:hidden">
          {rows.map((e, i) => (
            <div
              key={e.rank}
              style={staggerDelay(shown, reduced, i, 45)}
              className={cn(
                'flex items-center justify-between px-4 py-3 hover:bg-neutral-800/50',
                !reduced &&
                  'transition-[opacity,transform] duration-500 ease-out',
                show ? 'translate-y-0 opacity-100' : 'translate-y-3 opacity-0',
              )}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="w-5 shrink-0 text-sm text-neutral-400">
                  {e.rank}
                </span>
                <Avatar src={e.avatar} name={e.name} />
                {/* Real collectors link by profile handle; rows without one
                    (mock board, pre-handle customers) keep the name link. */}
                <Link
                  href={`/profile/${e.handle ?? e.name}`}
                  className="truncate text-sm text-neutral-50 hover:underline"
                >
                  {e.name}
                </Link>
              </div>
              <span className="shrink-0 pl-3 text-sm text-neutral-50">
                {e.points} <span className="text-neutral-400">pts</span>
              </span>
            </div>
          ))}
        </div>

        {/* Desktop table */}
        <div className="hidden overflow-x-auto sm:block">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-neutral-800">
                <th className="px-6 py-1 text-center text-sm font-medium text-neutral-400">
                  #
                </th>
                <th className="px-4 py-1 text-left text-sm font-medium text-neutral-400">
                  Name
                </th>
                <th className="px-4 py-1 text-left text-sm font-medium text-neutral-400">
                  Volume
                </th>
                <th className="px-4 py-1 text-center text-sm font-medium text-neutral-400">
                  Claw Pulls
                </th>
                <th className="px-6 py-1 text-right text-sm font-medium text-neutral-400">
                  Points
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr
                  key={e.rank}
                  style={staggerDelay(shown, reduced, i, 45)}
                  className={cn(
                    'border-b border-neutral-800 last:border-0 hover:bg-neutral-800/50',
                    !reduced &&
                      'transition-[opacity,transform] duration-500 ease-out',
                    show
                      ? 'translate-y-0 opacity-100'
                      : 'translate-y-3 opacity-0',
                  )}
                >
                  <td className="px-6 py-4 text-center text-sm text-neutral-50">
                    {e.rank}
                  </td>
                  <td className="px-4 py-4 text-left text-sm text-neutral-50">
                    <div className="flex items-center gap-3">
                      <Avatar src={e.avatar} name={e.name} />
                      <Link
                        href={`/profile/${e.handle ?? e.name}`}
                        className="whitespace-nowrap hover:underline"
                      >
                        {e.name}
                      </Link>
                    </div>
                  </td>
                  <td className="whitespace-nowrap px-4 py-4 text-left text-sm text-neutral-50">
                    {e.volume}
                  </td>
                  <td className="px-4 py-4 text-center text-sm text-neutral-50">
                    {e.pulls}
                  </td>
                  <td className="whitespace-nowrap px-6 py-4 text-right text-sm text-neutral-50">
                    {e.points}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
