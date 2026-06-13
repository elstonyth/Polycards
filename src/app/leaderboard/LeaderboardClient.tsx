'use client';

import { useEffect, useState } from 'react';
import { Settings, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';
import Reveal from '@/components/Reveal';
import LeaderboardSection from '@/components/LeaderboardSection';
import type { LeaderboardEntry } from '@/lib/data/leaderboard';

type PodiumPlayer = {
  rank: 1 | 2 | 3;
  name: string;
  points: string;
  avatar: string;
};

const TABS = ['Weekly', 'All Time', 'Prizes'] as const;
type Tab = (typeof TABS)[number];

const PRIZE_TIERS = [
  { place: '1st Place', reward: 'Grand prize pack + 50,000 bonus points' },
  { place: '2nd Place', reward: 'Premium pack + 25,000 bonus points' },
  { place: '3rd Place', reward: 'Premium pack + 10,000 bonus points' },
  { place: 'Top 10', reward: 'Exclusive pack + 5,000 bonus points' },
  { place: 'Top 100', reward: '1,000 bonus points' },
];

// Weekly leaderboard countdown (matches the live "6d 07h 33m 59s" format).
const INITIAL_SECONDS = 6 * 86400 + 7 * 3600 + 33 * 60 + 59;

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

function useCountdown(initialSeconds: number): number {
  const [seconds, setSeconds] = useState(initialSeconds);

  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((s) => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return seconds;
}

function Countdown() {
  const total = useCountdown(INITIAL_SECONDS);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const segments: [number, string][] = [
    [d, 'd'],
    [h, 'h'],
    [m, 'm'],
    [s, 's'],
  ];

  // Bordered pill + clock icon + boxed time segments (matches the live podium header).
  return (
    <div className="flex items-center justify-end">
      <div className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[13px] text-white/50">
        <Clock className="h-3.5 w-3.5 text-white/40" aria-hidden />
        <span>Winners picked in:</span>
        <span className="flex items-center gap-1">
          {segments.map(([v, u]) => (
            <span
              key={u}
              className="rounded-md border border-white/10 bg-white/[0.05] px-1.5 py-0.5 font-medium tabular-nums text-white/80"
            >
              {u === 'd' ? v : pad(v)}
              <span className="text-white/40">{u}</span>
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

function PodiumColumn({ player }: { player: PodiumPlayer }) {
  const isFirst = player.rank === 1;

  return (
    <div
      className={cn(
        'flex h-full min-w-0 flex-col items-center justify-end text-center',
        // Order = 2nd | 1st | 3rd; the graduated pedestal heights lift 1st highest.
        isFirst ? 'order-2' : player.rank === 2 ? 'order-1' : 'order-3',
      )}
    >
      <div className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={player.avatar}
          alt={player.name}
          width={isFirst ? 64 : 48}
          height={isFirst ? 64 : 48}
          loading="lazy"
          className={cn(
            'rounded-full object-cover ring-2 ring-offset-2 ring-offset-neutral-950',
            isFirst
              ? 'h-14 w-14 ring-amber-400 sm:h-16 sm:w-16'
              : 'h-10 w-10 ring-white/15 sm:h-11 sm:w-11',
          )}
        />
        {/* rank badge */}
        <span
          className={cn(
            'absolute -top-2 left-1/2 flex h-6 w-6 -translate-x-1/2 items-center justify-center rounded-full text-[11px] font-bold shadow',
            isFirst
              ? 'h-7 w-7 bg-amber-400 text-neutral-950'
              : player.rank === 2
                ? 'bg-neutral-300 text-neutral-900'
                : 'bg-amber-700 text-amber-50',
          )}
          aria-hidden
        >
          {isFirst ? '♔' : player.rank}
        </span>
      </div>

      <p
        className={cn(
          'mt-3 w-full max-w-[10rem] truncate px-1 font-medium text-white',
          isFirst ? 'text-sm sm:text-base' : 'text-[13px]',
        )}
        title={player.name}
      >
        {player.name}
      </p>
      <p className={cn('text-white/45', isFirst ? 'text-[13px]' : 'text-xs')}>
        {player.points} points
      </p>

      {/* Pedestal — rises up from the box floor on load (staggered 2nd → 3rd → 1st).
          The fixed-height box clips it, so it never pushes the layout below down. */}
      <div
        aria-hidden
        style={{
          animationDelay: isFirst
            ? '180ms'
            : player.rank === 2
              ? '0ms'
              : '90ms',
        }}
        className={cn(
          'mt-2 w-16 origin-bottom rounded-t-xl border border-b-0 border-white/10',
          'bg-gradient-to-b from-white/[0.14] to-white/[0.05] sm:w-20',
          // Smoother rise: easeOutExpo-style decel + fade (see podiumRise keyframe).
          'motion-safe:animate-[podiumRise_0.85s_cubic-bezier(0.16,1,0.3,1)_both]',
          isFirst
            ? 'h-[116px] sm:h-[140px]'
            : player.rank === 2
              ? 'h-[84px] sm:h-[104px]'
              : 'h-[60px] sm:h-[76px]',
        )}
      />
    </div>
  );
}

function PrizesPanel() {
  return (
    <div className="mt-10 overflow-hidden rounded-xl border border-neutral-800 bg-neutral-900 sm:mt-14">
      <div className="border-b border-neutral-800 px-6 py-5">
        <h2 className="font-heading text-xl font-bold tracking-tight text-white">
          Weekly prize pool
        </h2>
        <p className="mt-1 text-[13px] text-white/45">
          Earn points on every purchase. Top collectors claim weekly rewards.
        </p>
      </div>
      <ul className="divide-y divide-neutral-800">
        {PRIZE_TIERS.map((tier) => (
          <li
            key={tier.place}
            className="flex items-center justify-between gap-4 px-6 py-4"
          >
            <span className="text-sm font-medium text-white">{tier.place}</span>
            <span className="text-right text-[13px] text-white/45">
              {tier.reward}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Pagination({ count }: { count: number }) {
  const pages = [1, 2, 3];

  return (
    <div className="mt-6 flex flex-col items-center justify-between gap-4 sm:flex-row">
      <p className="text-[13px] text-white/45">
        1-{count} of {count}
      </p>
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          aria-label="Previous page"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ChevronLeft className="h-4 w-4" aria-hidden />
        </button>
        {pages.map((p) => (
          <button
            key={p}
            type="button"
            aria-label={`Page ${p}`}
            aria-current={p === 1 ? 'page' : undefined}
            className={cn(
              'flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-sm transition-colors',
              p === 1
                ? 'bg-white text-neutral-950'
                : 'border border-white/10 bg-white/[0.03] text-white/60 hover:bg-white/10 hover:text-white',
            )}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          aria-label="Next page"
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <ChevronRight className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export default function LeaderboardClient({
  weekly,
  alltime,
}: {
  weekly: LeaderboardEntry[];
  alltime: LeaderboardEntry[];
}) {
  const [tab, setTab] = useState<Tab>('Weekly');

  // Podium + table reflect the active timeframe (Prizes keeps the weekly view).
  const activeEntries = tab === 'All Time' ? alltime : weekly;
  const podium: PodiumPlayer[] = activeEntries.slice(0, 3).map((e, i) => ({
    rank: (i + 1) as 1 | 2 | 3,
    name: e.name,
    points: e.points,
    avatar: e.avatar,
  }));

  return (
    <div className="mx-auto w-full px-fluid py-4">
      {/* 1. Countdown line */}
      <Reveal as="div" className="mb-4 mt-1">
        <Countdown />
      </Reveal>

      {/* 2. Top-3 podium — fixed-height clipped box (matches the live h-[300px]).
          The pedestal bars rise INSIDE this box, so the layout below (Win prizes!,
          tabs, table) never shifts. */}
      <Reveal
        as="section"
        y={0}
        className="relative h-[260px] overflow-hidden rounded-2xl border border-white/10 bg-neutral-950 sm:h-[300px]"
      >
        {/* Tight centered cluster — avatar centers ~132px apart, matching the live podium
            (measured before its login-redirect). Narrow max-width + small gap. */}
        <div className="mx-auto grid h-full max-w-[27rem] grid-cols-3 items-end gap-2 px-6 pb-0 pt-6 sm:gap-3">
          {podium.map((p) => (
            <PodiumColumn key={p.rank} player={p} />
          ))}
        </div>
      </Reveal>

      {/* 3. Win prizes! + settings gear */}
      <div className="mt-6 flex items-center justify-between gap-3">
        <button
          type="button"
          aria-label="Leaderboard settings"
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-white/60 transition-colors hover:bg-white/10 hover:text-white"
        >
          <Settings className="h-4 w-4" aria-hidden />
        </button>
        <button
          type="button"
          onClick={() => setTab('Prizes')}
          className="inline-flex items-center justify-center rounded-2xl bg-white/90 px-5 py-2.5 text-sm font-semibold text-neutral-950 shadow-lg transition-colors duration-300 hover:bg-white"
        >
          Win prizes!
        </button>
      </div>

      {/* 4. Tabs */}
      <div
        role="tablist"
        aria-label="Leaderboard timeframe"
        className="mt-4 grid grid-cols-3 gap-1 rounded-xl border border-white/10 bg-neutral-900 p-1"
      >
        {TABS.map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn(
              'rounded-lg px-3 py-2 text-center text-sm font-medium transition-colors',
              tab === t
                ? 'bg-white/10 text-white'
                : 'text-white/45 hover:text-white/70',
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {tab === 'Prizes' ? (
        <PrizesPanel />
      ) : (
        <>
          {/* Re-mount the table when switching Weekly/All Time so its reveal
              animation re-runs and the content visibly changes. */}
          <LeaderboardSection
            key={tab}
            showHeading={false}
            entries={activeEntries}
          />
          <Pagination count={activeEntries.length} />
        </>
      )}
    </div>
  );
}
