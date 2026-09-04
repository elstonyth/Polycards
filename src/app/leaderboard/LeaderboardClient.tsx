'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { FramedAvatar } from '@/components/FramedAvatar';
import { RankGlyph } from '@/components/RankGlyph';
import { PrizeCard } from './PrizeCard';
import { findOwnRow, gapLockup, rankGap } from '@/lib/leaderboard-gap';
import type { LeaderboardEntry, OwnWeekly } from '@/lib/data/leaderboard';
import type { ChallengeRankPrize } from '@/lib/data/challenge';

const PERIODS = ['This Week', 'All Time'] as const;
type Period = (typeof PERIODS)[number];

/** One label/value column of the Sticky Stat Card — uppercase Label over a
 *  Nekst Black value (DESIGN.md §"Signature: Sticky Stat Card"). */
function StatCell({
  label,
  value,
  className,
  valueClassName,
}: {
  label: string;
  value: string;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={className}>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
        {label}
      </p>
      <p
        className={cn(
          'font-heading text-2xl tabular-nums text-white',
          valueClassName,
        )}
      >
        {value}
      </p>
    </div>
  );
}

export default function LeaderboardClient({
  weekly,
  alltime,
  ownHandle,
  ownWeekly = null,
  weeklyPrizes = [],
}: {
  weekly: LeaderboardEntry[];
  alltime: LeaderboardEntry[];
  ownHandle: string | null;
  /** The caller's own pulled value this challenge week — the figure that makes
   *  a gap statable for a player the top-10 slice cut off. null when logged out
   *  or the hop failed. */
  ownWeekly?: OwnWeekly | null;
  /** Sparse per-rank CURRENT challenge prizes (unlocked stages, cumulative) —
   *  rendered on the This Week rows only, since that IS the challenge board. */
  weeklyPrizes?: ChallengeRankPrize[];
}) {
  const [period, setPeriod] = useState<Period>('This Week');
  const entries = period === 'All Time' ? alltime : weekly;
  const prizeByRank = new Map(weeklyPrizes.map((p) => [p.rank, p]));
  // When ANY row shows a prize, every row reserves the prize column (fixed
  // width, empty spacer on prizeless rows) so the RM figures stay aligned.
  const showPrizeCol = period === 'This Week' && weeklyPrizes.length > 0;

  // Resolved through the SAME lookup rankGap uses (seed first, handle second),
  // so the card's rank figure and its gap can never disagree about whether the
  // viewer is on the board.
  const own = findOwnRow(entries, ownHandle, ownWeekly)?.row ?? null;

  // This Week only. All Time ranks by pack-open spend while displaying pulled
  // value, so the difference between two adjacent All Time rows is not what
  // separates them — see leaderboard-gap.ts.
  const lockup =
    period === 'This Week'
      ? gapLockup(rankGap(entries, ownHandle, ownWeekly))
      : null;

  return (
    <div className="px-fluid mx-auto w-full max-w-md pt-6 lg:max-w-3xl">
      <div className="flex items-center justify-between">
        {/* h2: the page's h1 is "Ranks" on the route, which also owns the
            Weekly Challenge block rendered above these standings. */}
        <h2 className="font-heading text-3xl text-white">LEADERBOARD</h2>
      </div>

      {/* Period toggle — 90scard's Past / This Week pills. Plain toggle
          buttons (aria-pressed), not ARIA tabs — there are no tab panels. */}
      <div
        role="group"
        aria-label="Leaderboard timeframe"
        className="mt-4 grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-neutral-900 p-1"
      >
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={period === p}
            onClick={() => setPeriod(p)}
            className={cn(
              'rounded-full px-3 py-2.5 text-center text-sm font-semibold transition-colors',
              period === p
                ? 'bg-neutral-50 text-neutral-950'
                : 'text-neutral-400 hover:text-white',
            )}
          >
            {p}
          </button>
        ))}
      </div>

      {/* How the board works — honest, no payout promise. */}
      <p className="mt-3 text-[12px] text-neutral-400">
        {period === 'This Week'
          ? 'This week ranks by pulled value — every eligible pack draw counts. It is the Weekly Challenge board.'
          : 'All Time — ranked by lifetime pack-open spend; showing each player’s lifetime pulled value.'}
      </p>

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
          <>
            {/* Column header — operator-requested layout (2026-07-23 voice
                notes): weekly = "# Player · reward" (pulled value moved under
                the name), All Time = "# Player · pulled value". Spacer mirrors
                the 36px avatar so "Player" starts over the names. */}
            {/* text-neutral-400, not -500: -500 on bg-neutral-900 measures
                ~3.8:1 (axe flagged it at 4.17:1 in CI), under the 4.5:1 AA
                floor — -400 measures ~6.9:1 (plan 070 step 4). */}
            <div className="mt-3 flex items-center gap-3 px-4 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
              <span className="w-8 shrink-0 text-center">#</span>
              <span aria-hidden className="w-9 shrink-0" />
              <span className="min-w-0 flex-1">Player</span>
              {showPrizeCol && (
                <span className="min-w-16 shrink-0 text-right">Reward</span>
              )}
              {period === 'All Time' && (
                <span className="shrink-0 text-right">Pulled value</span>
              )}
            </div>
            <ol className="mt-2 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
              {entries.map((entry, i) => {
                const isOwn = own != null && entry.seed === own.seed;
                const prize =
                  period === 'This Week'
                    ? prizeByRank.get(entry.rank)
                    : undefined;
                return (
                  <li
                    key={`${entry.rank}-${entry.name}`}
                    className={cn(
                      'flex items-center gap-3 px-4 py-3',
                      i > 0 && 'border-t border-white/5',
                      isOwn && 'bg-white/[0.04]',
                    )}
                  >
                    <RankGlyph rank={entry.rank} />
                    <FramedAvatar
                      src={entry.avatar}
                      frameSrc={entry.frame}
                      size={36}
                    />
                    <div className="min-w-0 flex-1">
                      {entry.handle ? (
                        <Link
                          href={`/profile/${entry.handle}`}
                          className="-my-1 block truncate py-1 text-sm font-semibold text-white hover:underline"
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
                      {/* Weekly: "RM 738,106.76 · 84 pulls" under the name
                        (operator voice notes 2026-07-23). All Time keeps pulls
                        only — the RM spend under a name there was
                        operator-rejected ("don't show how much money drawn"). */}
                      {/* No truncate: with a 4-slab reward the cell narrows
                        enough to clip "· 84 pulls" — wrap at the dot instead
                        (each side is nowrap, so the value never splits). */}
                      <p className="text-[12px] text-neutral-400">
                        {period === 'This Week' ? (
                          <>
                            <span className="font-semibold whitespace-nowrap tabular-nums text-white">
                              {entry.volume}
                            </span>
                            <span className="whitespace-nowrap">
                              {` · ${entry.pulls} pulls`}
                            </span>
                          </>
                        ) : (
                          `${entry.pulls} pulls`
                        )}
                      </p>
                    </div>
                    {/* Weekly board only: the CURRENT challenge prize for this
                      rank — card thumb and/or credits, from the unlocked
                      stages' prize tables. The reward IS the row's right edge
                      on weekly (operator 2026-07-23: value under the name,
                      "right side all reward"). Thumb height matches the
                      avatar so the row keeps its one-line height. min-w-16 is
                      the shared column basis (with a spacer on prizeless
                      rows) keeping the rewards column-aligned across rows —
                      sized for the widest single-type prize (cumulative
                      credits, e.g. "RM 18,500"). A rank paying card AND
                      credits grows past it — deliberate: rewards never clip. */}
                    {prize ? (
                      <span
                        className="flex min-w-16 flex-wrap items-center justify-end gap-1"
                        aria-label={`Current prize: ${[
                          ...prize.cards.map((c) => c.name),
                          prize.creditsLabel
                            ? `${prize.creditsLabel} credits`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(', ')}`}
                      >
                        {/* EVERY prize card renders (operator rejected the +N
                            collapse). Frame rule and the "View Details" link
                            live in PrizeCard. */}
                        {prize.cards.map((card, ci) => (
                          <span key={`${card.name}-${ci}`} className="shrink-0">
                            <PrizeCard
                              card={card}
                              glowScale={0.15}
                              sizes="96px"
                              className="h-10 drop-shadow-[0_4px_8px_rgba(0,0,0,0.6)]"
                              affordance="ring"
                            />
                          </span>
                        ))}
                        {prize.creditsLabel && (
                          <span className="text-chase text-xs font-semibold whitespace-nowrap">
                            {prize.creditsLabel}
                          </span>
                        )}
                      </span>
                    ) : showPrizeCol ? (
                      <span aria-hidden className="min-w-16 shrink-0" />
                    ) : null}
                    {/* All Time only: pulled value figure (operator 2026-07-23
                      "写回pulled value" — the old points figure is retired from
                      the UI; ranking stays backend spend-order). Weekly rows
                      end on the reward — the value lives under the name. */}
                    {period === 'All Time' && (
                      <span className="font-heading shrink-0 text-base tabular-nums text-white">
                        {entry.volume}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>

      {/* Your-rank card — floats above the tab bar (90scard signature). */}
      {ownHandle != null && (
        <div className="fixed inset-x-4 bottom-24 z-40 mx-auto max-w-md rounded-2xl border border-white/10 bg-neutral-900 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.6)] lg:bottom-8">
          {own ? (
            <>
              <div className="flex items-center justify-between gap-3">
                <StatCell label="Your rank" value={`#${own.rank}`} />
                <StatCell
                  label="Pulled"
                  value={own.volume}
                  className="text-right"
                  valueClassName="text-chase"
                />
              </div>
              {/* The climb, as its own label/value row under both figures: it
                  belongs to neither column, and the card is fixed above the tab
                  bar with no width to spare. */}
              {lockup && (
                <StatCell
                  label={lockup.label}
                  value={lockup.value}
                  className="mt-3 border-t border-white/5 pt-3"
                />
              )}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
                    Your rank
                  </p>
                  {/* Stays "Not on the board yet" — that is still the true
                      answer to this label, and replacing it with a money figure
                      made the eyebrow lie. The distance gets its own row
                      below. */}
                  <p className="text-sm font-semibold text-white">
                    Not on the board yet
                  </p>
                </div>
                <Link
                  href="/"
                  className={cn(
                    pillVariants({ size: 'md' }),
                    'shrink-0 text-[13px]',
                  )}
                >
                  Rip a pack
                </Link>
              </div>
              {/* A player who has ripped this week gets the distance: the gap
                  is the number that makes the next rip feel reachable. A cold
                  start (no pulls yet) has no row here — quoting the whole #10
                  figure at someone with nothing on the board reads as a wall. */}
              {lockup && (
                <StatCell
                  label={lockup.label}
                  value={lockup.value}
                  className="mt-3 border-t border-white/5 pt-3"
                />
              )}
            </>
          )}
        </div>
      )}

      {/* Clearance for the fixed your-rank card lives on the route, after the
          last block on the page (the rules follow these standings). */}
    </div>
  );
}
