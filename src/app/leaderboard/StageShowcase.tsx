'use client';

// Weekly reward stages: a row of stage tabs (each with its unlock amount) over
// one stage's prizes standing on a podium, #1 in the centre under a soft
// spotlight. The 21st "Leaderboard Podium" layout (2nd, 1st, 3rd on stepped
// blocks), rebuilt in house CSS around the prize slabs. Opens on the stage the
// community pool is climbing toward.
import { useState, type CSSProperties } from 'react';
import { Check, ChevronRight, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ChallengeCard,
  ChallengeRankReward,
  ChallengeStage,
} from '@/lib/data/challenge';
import { PrizeCard } from './PrizeCard';
import { RankRewardSheet } from './RankRewardSheet';

// Podium places by rank: grid column (1 centre, 2 left, 3 right), the medal
// tone of the numeral, the slab's height and the block's height. Bronze is
// amber-500 (the house bronze: the player podium's ring uses it too).
const PLACES = {
  1: {
    col: 'col-start-2',
    tone: 'text-chase',
    edge: 'border-t-chase/60',
    slab: 'h-36 sm:h-56',
    block: 'h-16 sm:h-20',
    suffix: 'ST',
  },
  2: {
    col: 'col-start-1',
    tone: 'text-neutral-300',
    edge: 'border-t-neutral-300/50',
    slab: 'h-28 sm:h-44',
    block: 'h-11 sm:h-14',
    suffix: 'ND',
  },
  3: {
    col: 'col-start-3',
    tone: 'text-amber-500',
    edge: 'border-t-amber-500/50',
    slab: 'h-28 sm:h-44',
    block: 'h-7 sm:h-9',
    suffix: 'RD',
  },
} as const;

function StageTabs({
  stages,
  index,
  onPick,
}: {
  stages: ChallengeStage[];
  index: number;
  onPick: (i: number) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Reward stages"
      className="grid grid-cols-4 gap-1 rounded-2xl border border-white/10 bg-neutral-900 p-1"
    >
      {stages.map((s, i) => {
        const on = i === index;
        return (
          <button
            key={s.stageNumber}
            type="button"
            aria-pressed={on}
            aria-label={`Stage ${s.stageNumber}, ${
              s.state === 'complete'
                ? 'unlocked'
                : s.state === 'active'
                  ? 'up next'
                  : 'locked'
            }, unlocks at ${s.threshold}`}
            onClick={() => onPick(i)}
            className={cn(
              'flex min-h-12 flex-col items-center justify-center rounded-xl px-1 py-1.5 transition-colors',
              'outline-none focus-visible:ring-2 focus-visible:ring-white/40',
              on
                ? 'bg-neutral-700 text-white'
                : 'text-neutral-400 hover:bg-white/5 hover:text-white',
            )}
          >
            <span className="flex items-center gap-1 text-xs font-bold">
              {s.state === 'complete' && (
                <Check className="text-chase h-3 w-3" aria-hidden />
              )}
              {s.state === 'locked' && <Lock className="h-3 w-3" aria-hidden />}
              {s.state === 'active' && (
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
                />
              )}
              Stage {s.stageNumber}
            </span>
            <span className="mt-0.5 text-[10px] font-semibold tabular-nums opacity-70">
              {s.thresholdCompact}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function StagePodium({ stage }: { stage: ChallengeStage }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  // Podium = ranks 1-3 that have a card; credits on ranks 1-3 have no display
  // surface yet (migrated config is card-only there, plan 057).
  const podium = stage.rankRewards.filter(
    (r): r is ChallengeRankReward & { card: ChallengeCard } =>
      r.rank <= 3 && r.card !== null,
  );
  const rest = stage.rankRewards.filter((r) => r.rank >= 4);
  const locked = stage.state !== 'complete' && stage.state !== 'active';

  return (
    <div className="relative mt-3 overflow-hidden rounded-3xl border border-white/10 bg-neutral-900">
      {/* The spotlight: a soft white pool over #1. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-full bg-[radial-gradient(42%_60%_at_50%_0%,rgba(255,255,255,0.13),transparent_72%)]"
      />

      <div className="relative flex items-start justify-between gap-3 px-4 pt-4 sm:px-6 sm:pt-5">
        <div>
          <p className="font-heading text-2xl leading-none text-white sm:text-3xl">
            STAGE {stage.stageNumber}
          </p>
          <p className="mt-1.5 text-xs text-neutral-400">
            {stage.state === 'complete' ? 'Unlocked at ' : 'Unlocks at '}
            <span className="font-semibold text-neutral-200 tabular-nums">
              {stage.threshold}
            </span>
          </p>
        </div>
        {stage.state === 'complete' ? (
          <span className="bg-chase flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold text-neutral-950">
            <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
            Unlocked
          </span>
        ) : stage.state === 'active' ? (
          <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-bold text-neutral-950">
            Up next
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-full border border-white/10 bg-neutral-800 px-2.5 py-1 text-[11px] font-bold text-neutral-300">
            <Lock className="h-3 w-3" aria-hidden />
            Locked
          </span>
        )}
      </div>

      {/* The podium. Re-keyed per stage so the prizes rise again on a pick.
          The list keeps rank order for screen readers; the columns place it. */}
      <ol
        key={stage.stageNumber}
        aria-label={`Stage ${stage.stageNumber} top three prizes`}
        className="relative mx-auto mt-4 grid max-w-xl grid-cols-3 items-end gap-2 px-3 sm:gap-4 sm:px-6"
      >
        {podium.map((r) => {
          const place = PLACES[r.rank as 1 | 2 | 3];
          return (
            <li
              key={r.rank}
              className={cn(
                'row-start-1 flex min-w-0 flex-col items-center text-center',
                place.col,
              )}
            >
              <div
                className={cn(
                  'stage-rise transition-transform duration-200 hover:-translate-y-0.5 motion-reduce:animate-none',
                  locked && 'opacity-80',
                )}
                style={{ '--i': r.rank - 1 } as CSSProperties}
              >
                <PrizeCard
                  card={r.card}
                  glowScale={r.rank === 1 ? 0.45 : 0.3}
                  sizes="320px"
                  className={cn(
                    place.slab,
                    'drop-shadow-[0_14px_22px_rgba(0,0,0,0.7)]',
                  )}
                />
              </div>
              <p className="mt-2 line-clamp-2 min-h-[2lh] w-full text-[10px] leading-tight font-semibold tracking-wide text-neutral-300 uppercase sm:text-[11px]">
                {r.card.name}
              </p>
              <span
                aria-hidden
                className={cn(
                  'font-heading mt-2 flex w-full items-start justify-center rounded-t-xl border-t-2 bg-gradient-to-b from-white/[0.09] to-white/[0.02] pt-1.5 text-xl leading-none italic sm:text-2xl',
                  place.block,
                  place.edge,
                  place.tone,
                )}
              >
                #{r.rank}
                <span className="text-[10px] sm:text-xs">{place.suffix}</span>
              </span>
            </li>
          );
        })}
      </ol>

      {/* Ranks 4-10: the floor under the podium, opening the per-rank sheet.
          stage.reward is the SUM across ranks 4-10, so it reads as a total. */}
      <button
        type="button"
        onClick={() => setSheetOpen(true)}
        aria-label={`View rewards for ranks 4 to 10 of stage ${stage.stageNumber}`}
        className="relative flex w-full items-center gap-3 border-t border-white/10 bg-neutral-950/60 px-4 py-3 text-left transition-colors outline-none hover:bg-neutral-800 focus-visible:ring-2 focus-visible:ring-white/40 focus-visible:ring-inset sm:px-6"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/images/task/credits-coins.webp"
          alt=""
          loading="lazy"
          decoding="async"
          className="h-10 w-10 shrink-0 object-contain"
        />
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-semibold tracking-[0.08em] text-neutral-400 uppercase">
            Ranks 4–10
            {rest.length > 0 && ` · ${rest.length} prizes`}
          </span>
          <span className="text-chase font-heading block text-lg leading-tight tabular-nums">
            {stage.reward}
            <span className="ml-1 font-sans text-xs font-semibold text-neutral-400">
              total
            </span>
          </span>
        </span>
        <ChevronRight
          className="h-5 w-5 shrink-0 text-neutral-500"
          aria-hidden
        />
      </button>
      <RankRewardSheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        stageNumber={stage.stageNumber}
        rewards={rest}
      />
    </div>
  );
}

export function StageShowcase({ stages }: { stages: ChallengeStage[] }) {
  // Open on the stage the pool is climbing toward (else the last one).
  const activeStage = stages.findIndex((s) => s.state === 'active');
  const [index, setIndex] = useState(
    activeStage >= 0 ? activeStage : Math.max(0, stages.length - 1),
  );
  const stage = stages[index];
  if (!stage) return null;
  return (
    <>
      <StageTabs stages={stages} index={index} onPick={setIndex} />
      <StagePodium stage={stage} />
    </>
  );
}
