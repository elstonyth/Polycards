'use client';

import { useState } from 'react';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { pillVariants } from '@/components/ui/pill';
import { PAGE_COLUMN } from '@/components/ui/page-frame';
import { FramedAvatar } from '@/components/FramedAvatar';
import { RankGlyph } from '@/components/RankGlyph';
import { PrizeCard } from './PrizeCard';
import { findOwnRow, gapLockup, rankGap } from '@/lib/leaderboard-gap';
import type { LeaderboardEntry, OwnWeekly } from '@/lib/data/leaderboard';
import type { ChallengeRankPrize } from '@/lib/data/challenge';
import { HoloIcon } from '@/components/holo-3d/HoloIcon';

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
      <p className="text-[11px] font-semibold tracking-[0.08em] text-neutral-400 uppercase">
        {label}
      </p>
      <p
        className={cn(
          'font-heading text-2xl text-white tabular-nums',
          valueClassName,
        )}
      >
        {value}
      </p>
    </div>
  );
}

/** The CURRENT challenge prize for a rank — card thumbs and/or credits, from
 *  the unlocked stages' prize tables. EVERY prize card renders (operator
 *  rejected the +N collapse); the frame rule and the "View Details" link live
 *  in PrizeCard. A rank paying card AND credits grows past min-w-16 on a row —
 *  deliberate: rewards never clip. */
function RankPrize({
  prize,
  className,
}: {
  prize: ChallengeRankPrize;
  className?: string;
}) {
  return (
    <span
      className={cn('flex flex-wrap items-center gap-1', className)}
      aria-label={`Current prize: ${[
        ...prize.cards.map((c) => c.name),
        prize.creditsLabel ? `${prize.creditsLabel} bonus credits` : null,
      ]
        .filter(Boolean)
        .join(', ')}`}
    >
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
          {prize.creditsLabel} bonus
        </span>
      )}
    </span>
  );
}

/** A player's name: their profile link when they have a handle. */
function PlayerName({
  entry,
  isOwn,
  className,
}: {
  entry: LeaderboardEntry;
  isOwn: boolean;
  className?: string;
}) {
  const you = isOwn && (
    <span className="text-chase ml-1.5 text-[11px] font-bold">YOU</span>
  );
  return entry.handle ? (
    <Link
      href={`/profile/${entry.handle}`}
      prefetch={false}
      className={cn(
        'block truncate text-sm font-semibold text-white hover:underline',
        className,
      )}
    >
      {entry.name}
      {you}
    </Link>
  ) : (
    <span
      className={cn(
        'block truncate text-sm font-semibold text-white',
        className,
      )}
    >
      {entry.name}
      {you}
    </span>
  );
}

// Podium places, by rank: grid column (1 centre, 2 left, 3 right), the
// crown's and the avatar ring's metal, the avatar size and the stepped
// block's height.
const PLACES = [
  {
    col: 'col-start-2',
    tone: 'gold',
    crown: '-mb-5 w-16 sm:w-20',
    ring: 'ring-chase',
    avatar: 72,
    block: 'h-20',
    num: 'text-chase',
  },
  {
    col: 'col-start-1',
    tone: 'silver',
    crown: '-mb-4 w-12 sm:w-14',
    ring: 'ring-neutral-300',
    avatar: 56,
    block: 'h-14',
    num: 'text-neutral-300',
  },
  {
    col: 'col-start-3',
    tone: 'bronze',
    crown: '-mb-4 w-12 sm:w-14',
    // amber-500: the bronze the stage cards' #3RD numeral already uses.
    ring: 'ring-amber-500',
    avatar: 56,
    block: 'h-10',
    num: 'text-amber-500',
  },
] as const;

/** The top three of the selected period as a podium: rank 1 in the centre,
 *  tallest, under a gold crown; rank 2 left in silver, rank 3 right in bronze. The list keeps rank order
 *  (1, 2, 3) for screen readers; the grid columns place them. A board with
 *  one or two players shows just those places. */
function Podium({
  top,
  ownSeed,
  prizeFor,
  showPrize,
}: {
  top: LeaderboardEntry[];
  ownSeed: LeaderboardEntry['seed'] | null;
  prizeFor: (rank: number) => ChallengeRankPrize | undefined;
  showPrize: boolean;
}) {
  return (
    <ol
      aria-label="Top three"
      className="mt-6 grid grid-cols-3 items-end gap-2"
    >
      {top.map((entry, i) => {
        const place = PLACES[i]!;
        const first = i === 0;
        const prize = showPrize ? prizeFor(entry.rank) : undefined;
        return (
          <li
            key={`${entry.rank}-${entry.name}`}
            className={cn(
              'row-start-1 flex min-w-0 flex-col items-center text-center',
              place.col,
            )}
          >
            <HoloIcon
              kind="crown"
              tone={place.tone}
              className={cn('z-10', place.crown)}
            />
            <span className={cn('rounded-full p-1 ring-2', place.ring)}>
              <FramedAvatar
                src={entry.avatar}
                frameSrc={entry.frame}
                size={place.avatar}
              />
            </span>
            <PlayerName
              entry={entry}
              isOwn={ownSeed != null && entry.seed === ownSeed}
              // 44px tall for the tap, the same 20px line on screen.
              className="-mb-2 min-h-11 max-w-full pt-2 pb-4"
            />
            <p
              className={cn(
                'font-heading text-sm whitespace-nowrap tabular-nums sm:text-base',
                first ? 'text-chase' : 'text-white',
              )}
            >
              {entry.volume}
            </p>
            <p className="text-[11px] text-neutral-400">{entry.pulls} pulls</p>
            {showPrize && (
              <span className="mt-1.5 flex h-10 items-center justify-center">
                {prize && (
                  <RankPrize prize={prize} className="justify-center" />
                )}
              </span>
            )}
            <span
              aria-hidden
              className={cn(
                'font-heading mt-2 flex w-full items-start justify-center rounded-t-2xl border border-b-0 border-white/10 bg-neutral-900 pt-2 text-2xl leading-none',
                place.block,
                place.num,
              )}
            >
              {entry.rank}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export default function LeaderboardClient({
  weekly,
  alltime,
  ownHandle,
  ownWeekly = null,
  weeklyPrizes = [],
  titled = false,
}: {
  weekly: LeaderboardEntry[];
  alltime: LeaderboardEntry[];
  ownHandle: string | null;
  /** The caller's own pulled value this challenge week — the figure that makes
   *  a gap statable for a player the top-10 slice cut off. null when logged out
   *  or the hop failed. */
  ownWeekly?: OwnWeekly | null;
  /** Sparse per-rank CURRENT challenge prizes (unlocked stages, cumulative) —
   *  rendered on the This Week board only, since that IS the challenge board. */
  weeklyPrizes?: ChallengeRankPrize[];
  /** The challenge sits above: the standings get their own visible heading. */
  titled?: boolean;
}) {
  const [period, setPeriod] = useState<Period>('This Week');
  const entries = period === 'All Time' ? alltime : weekly;
  const prizeByRank = new Map(weeklyPrizes.map((p) => [p.rank, p]));
  // When ANY row shows a prize, every row reserves the prize column (fixed
  // width, empty spacer on prizeless rows) so the RM figures stay aligned.
  const showPrizeCol = period === 'This Week' && weeklyPrizes.length > 0;
  const prizeFor = (rank: number) =>
    period === 'This Week' ? prizeByRank.get(rank) : undefined;

  // Resolved through the SAME lookup rankGap uses (seed first, handle second),
  // so the card's rank figure and its gap can never disagree about whether the
  // viewer is on the board.
  const own = findOwnRow(entries, ownHandle, ownWeekly)?.row ?? null;

  // This Week only: the caller's own figure (ownWeekly) is a weekly one, so
  // there is nothing to measure an All Time gap from — see leaderboard-gap.ts.
  const lockup =
    period === 'This Week'
      ? gapLockup(rankGap(entries, ownHandle, ownWeekly))
      : null;

  const top = entries.slice(0, 3);
  const rest = entries.slice(3);

  return (
    <div className={cn(PAGE_COLUMN, titled ? 'mt-8' : 'pt-4')}>
      {/* Under the challenge the standings name themselves; alone, the page's
          h1 already does. */}
      <h2
        className={cn(
          titled ? 'text-lg font-semibold text-neutral-50' : 'sr-only',
        )}
      >
        Player ranks
      </h2>

      {/* Period toggle. Plain toggle buttons (aria-pressed), not ARIA tabs —
          there are no tab panels. */}
      <div
        role="group"
        aria-label="Leaderboard timeframe"
        className={cn(
          'grid grid-cols-2 gap-1 rounded-full border border-white/10 bg-neutral-900 p-1',
          titled ? 'mt-3' : 'mt-0',
        )}
      >
        {PERIODS.map((p) => (
          <button
            key={p}
            type="button"
            aria-pressed={period === p}
            onClick={() => setPeriod(p)}
            className={cn(
              'min-h-11 rounded-full px-3 py-2.5 text-center text-sm font-semibold transition-colors',
              'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
              period === p
                ? 'bg-neutral-700 text-white'
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
          ? 'This week ranks by pulled value — only the part of each pack you paid yourself counts. It is the Weekly Challenge board.'
          : 'All Time — ranked by lifetime pulled value, counting the part of each pack you paid yourself.'}
      </p>

      {entries.length === 0 ? (
        <div className="mt-4 rounded-3xl border border-white/10 bg-neutral-900 px-6 py-10 text-center">
          <p className="text-sm text-neutral-400">
            No pulls on the board yet — the first rip takes #1.
          </p>
        </div>
      ) : (
        <Podium
          top={top}
          ownSeed={own?.seed ?? null}
          prizeFor={prizeFor}
          showPrize={showPrizeCol}
        />
      )}

      {/* The floor the podium's blocks stand on. */}
      {entries.length > 0 && <div aria-hidden className="h-px bg-white/10" />}

      {rest.length > 0 && (
        <>
          {/* Column header — weekly = "# Player · reward" (pulled value under
              the name), All Time = "# Player · pulled value" (operator
              2026-07-23). The spacer mirrors the 36px avatar so "Player"
              starts over the names. */}
          <div className="mt-4 flex items-center gap-3 px-4 text-[11px] font-semibold tracking-wide text-neutral-400 uppercase">
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
          <ol
            aria-label="Ranks 4 and below"
            className="mt-2 overflow-hidden rounded-3xl border border-white/10 bg-neutral-900"
          >
            {rest.map((entry, i) => {
              const isOwn = own != null && entry.seed === own.seed;
              const prize = prizeFor(entry.rank);
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
                    <PlayerName
                      entry={entry}
                      isOwn={isOwn}
                      className={entry.handle ? '-my-1 min-h-11 py-3' : ''}
                    />
                    {/* Weekly: "RM 738,106.76 · 84 pulls" under the name. All
                        Time keeps pulls only — the RM spend under a name there
                        was operator-rejected. No truncate: wrap at the dot
                        (each side is nowrap, so the value never splits). */}
                    <p className="text-[12px] text-neutral-400">
                      {period === 'This Week' ? (
                        <>
                          <span className="font-semibold whitespace-nowrap text-white tabular-nums">
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
                  {prize ? (
                    <RankPrize prize={prize} className="min-w-16 justify-end" />
                  ) : showPrizeCol ? (
                    <span aria-hidden className="min-w-16 shrink-0" />
                  ) : null}
                  {/* All Time only: the pulled value figure. Weekly rows end
                      on the reward — the value lives under the name. */}
                  {period === 'All Time' && (
                    <span className="font-heading shrink-0 text-base text-white tabular-nums">
                      {entry.volume}
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
        </>
      )}

      {/* Your-rank card — floats above the floating tab bar: its 56px pill
          sits max(safe area, 8px) up and the centre Home button rises 10px
          above it, so 66px + a 10px gap. */}
      {ownHandle != null && (
        <div className="fixed inset-x-4 border-white/25 bottom-[calc(max(env(safe-area-inset-bottom),0.5rem)+4.75rem)] z-40 mx-auto max-w-md rounded-3xl border bg-neutral-900 p-4 shadow-[0_8px_32px_rgba(0,0,0,0.6)] lg:bottom-8">
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
                  <p className="text-[11px] font-semibold tracking-[0.08em] text-neutral-400 uppercase">
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
                {/* The screen's one glacier button. */}
                <Link
                  href="/"
                  className={cn(
                    pillVariants({ variant: 'glacier', size: 'md' }),
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
