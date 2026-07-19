'use client';

// Weekly reward stages as a swipeable rail — the same interaction as the VIP
// ladder (VipLevelCarousel): GalleryRail drag/momentum snapping, 3D neighbor
// peek, desktop chevrons, reduced-motion aware. One card per stage, opening on
// the stage the community pool is currently climbing toward.
import { useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Check, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChallengeStage } from '@/lib/data/challenge';
import { GalleryRail } from '@/app/slots/[slug]/GalleryRail';

// Medal-gradient rank numerals (#1ST gold / #2ND silver / #3RD bronze) — the
// prize-grid treatment from the operator's reference design.
const RANKS = [
  {
    label: '1',
    suffix: 'ST',
    grad: 'from-yellow-200 via-chase to-amber-600',
  },
  {
    label: '2',
    suffix: 'ND',
    grad: 'from-white via-neutral-300 to-neutral-500',
  },
  {
    label: '3',
    suffix: 'RD',
    grad: 'from-orange-300 via-amber-600 to-amber-800',
  },
] as const;

function RankNumeral({ rank }: { rank: (typeof RANKS)[number] }) {
  return (
    <span
      className={cn(
        'font-heading bg-gradient-to-b bg-clip-text text-2xl leading-none text-transparent italic',
        rank.grad,
      )}
    >
      #{rank.label}
      <span className="text-xs">{rank.suffix}</span>
    </span>
  );
}

function StageCard({
  stage,
  pooled,
}: {
  stage: ChallengeStage;
  pooled: string | null;
}) {
  const pct = Math.round(stage.progressPct ?? 0);
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[300px] flex-col rounded-2xl border p-5',
        stage.state === 'active'
          ? 'border-chase/60 bg-chase/[0.06]'
          : stage.state === 'complete'
            ? 'border-white/15 bg-white/[0.04]'
            : 'border-white/5 bg-white/[0.02]',
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'font-heading text-3xl',
            stage.state === 'locked' ? 'text-white/40' : 'text-chase',
          )}
        >
          STAGE {stage.stageNumber}
        </span>
        {stage.state === 'complete' && (
          <Check className="text-chase h-5 w-5" aria-label="Unlocked" />
        )}
        {stage.state === 'active' && (
          <span className="bg-chase rounded-full px-2 py-0.5 text-[11px] font-bold text-neutral-950">
            UP NEXT
          </span>
        )}
        {stage.state === 'locked' && (
          <Lock className="h-4 w-4 text-white/40" aria-label="Locked" />
        )}
      </div>
      <p className="mt-1 text-xs text-neutral-400">
        Unlock at{' '}
        <span className="font-semibold text-neutral-200">
          {stage.threshold}
        </span>
      </p>

      {/* Prize grid (reference design): each podium rank gets ITS card —
          reward_card_ids order is the ranking — plus the 4th-10th credits
          tile. Plain <img> (admin picker pattern) so backend-hosted art needs
          no Next remote-image config. */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        {stage.cards.slice(0, 3).map((c, i) => (
          <div
            key={`${c.name}-${i}`}
            className="flex flex-col rounded-xl border border-white/5 bg-white/[0.04] p-2.5"
          >
            <RankNumeral rank={RANKS[i]!} />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={c.image}
              alt=""
              loading="lazy"
              decoding="async"
              className="mx-auto mt-2 h-20 object-contain drop-shadow-[0_8px_16px_rgba(0,0,0,0.6)]"
            />
            <p className="mt-2 line-clamp-2 text-[9px] leading-tight font-semibold tracking-wide text-neutral-300 uppercase">
              {c.name}
            </p>
          </div>
        ))}
        <div className="flex flex-col rounded-xl border border-white/5 bg-white/[0.04] p-2.5">
          <span className="font-heading bg-gradient-to-b from-yellow-200 via-chase to-amber-600 bg-clip-text text-2xl leading-none text-transparent italic">
            #4<span className="text-xs">–10TH</span>
          </span>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/task/credits-coins.webp"
            alt=""
            loading="lazy"
            decoding="async"
            className="mx-auto mt-2 h-20 object-contain"
          />
          <p className="mt-2 text-[9px] leading-tight font-semibold tracking-wide text-neutral-300 uppercase">
            Credits{' '}
            <span className="text-chase block text-[11px]">{stage.reward}</span>
          </p>
        </div>
      </div>

      {/* Community-pool progress toward THIS stage (VIP-card bar pattern). */}
      {stage.progressPct !== null && (
        <div className="mt-4">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
            <div
              className="bg-chase h-full rounded-full"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] font-semibold text-neutral-500">
            <span>{stage.state === 'complete' ? stage.threshold : pooled}</span>
            <span>{stage.threshold}</span>
          </div>
        </div>
      )}
    </div>
  );
}

export function StageCarousel({
  stages,
  pooled,
}: {
  stages: ChallengeStage[];
  pooled: string | null;
}) {
  const reduced = useReducedMotion() ?? false;
  // Open on the stage the pool is climbing toward (else the last one).
  const activeStage = stages.findIndex((s) => s.state === 'active');
  const [index, setIndex] = useState(
    activeStage >= 0 ? activeStage : Math.max(0, stages.length - 1),
  );

  if (stages.length === 0) return null;

  return (
    <div className="mt-2">
      <GalleryRail
        count={stages.length}
        activeIndex={index}
        onIndexChange={setIndex}
        reduced={reduced}
      >
        {(i) => (
          // GalleryRail only calls children(i) for 0 <= i < count (same
          // non-null pattern as VipLevelCarousel).
          <StageCard stage={stages[i]!} pooled={pooled} />
        )}
      </GalleryRail>
    </div>
  );
}
