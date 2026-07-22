'use client';

import { useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Check, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm0 } from '@/lib/format';
import { levelProgressPct } from '@/lib/actions/vip-map';
import type { VipLevel } from '@/lib/actions/vip';
import { GalleryRail } from '@/app/slots/[slug]/GalleryRail';

type State = 'reached' | 'current' | 'locked';

function stateFor(level: number, highestLevel: number): State {
  if (level < highestLevel) return 'reached';
  if (level === highestLevel) return 'current';
  return 'locked';
}

function LevelCard({
  level,
  prevThreshold,
  highestLevel,
  spend,
}: {
  level: VipLevel;
  prevThreshold: number;
  highestLevel: number;
  spend: number;
}) {
  const state = stateFor(level.level, highestLevel);
  // Progress toward THIS rung, restarting at the previous rung's threshold —
  // reached rungs read 100%, the NEXT rung shows real progress within its
  // segment. Deeper locked rungs stay empty: a part-filled gold bar on a
  // locked card read as "nearly done" to real users (2026-07-22).
  const isNext = level.level === highestLevel + 1;
  const pct =
    state === 'locked' && !isNext
      ? 0
      : levelProgressPct(spend, prevThreshold, level.threshold);
  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-[300px] flex-col rounded-2xl border p-5',
        state === 'current'
          ? 'border-chase/60 bg-chase/[0.06]'
          : state === 'reached'
            ? 'border-white/15 bg-white/[0.04]'
            : 'border-white/5 bg-white/[0.02]',
      )}
    >
      <div className="flex items-center justify-between">
        <span
          className={cn(
            'font-heading text-3xl',
            state === 'locked' ? 'text-white/40' : 'text-chase',
          )}
        >
          LV {level.level}
        </span>
        {state === 'reached' && (
          <Check className="text-buyback-fg h-5 w-5" aria-label="Reached" />
        )}
        {state === 'current' && (
          <span className="bg-chase rounded-full px-2 py-0.5 text-[11px] font-bold text-neutral-950">
            YOU
          </span>
        )}
        {state === 'locked' && (
          <Lock className="h-4 w-4 text-white/40" aria-label="Locked" />
        )}
      </div>

      <ul className="mt-4 space-y-1.5 text-[13px] text-white/80">
        {level.reward.voucherAmount > 0 && (
          <li>{rm0(level.reward.voucherAmount)} voucher</li>
        )}
        <li>Tier {level.reward.boxTier.toUpperCase()} daily box</li>
        {level.reward.frameUnlock && <li>New avatar frame</li>}
        <li>{level.reward.directReferralPct}% referral rate</li>
      </ul>

      <div className="mt-4">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          {/* Dimmed on locked cards so in-progress gold never reads as
              "completed" next to reached rungs' full bars. */}
          <div
            className={cn(
              'h-full rounded-full',
              state === 'locked' ? 'bg-chase/40' : 'bg-chase',
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] font-semibold text-neutral-500">
          {/* Labels are the segment bounds the bar spans (previous rung →
              this rung), matching the restarting fill. Non-positive
              thresholds (e.g. the L1 base rung) have nothing to progress
              toward, so show lifetime spend against a dash instead. */}
          <span>{rm0(level.threshold > 0 ? prevThreshold : spend)}</span>
          <span>{level.threshold > 0 ? rm0(level.threshold) : '—'}</span>
        </div>
      </div>
    </div>
  );
}

export function VipLevelCarousel({
  levels,
  highestLevel,
  spend,
}: {
  levels: VipLevel[];
  highestLevel: number;
  spend: number;
}) {
  const reduced = useReducedMotion() ?? false;
  const initial = Math.max(
    0,
    levels.findIndex((l) => l.level === highestLevel),
  );
  const [index, setIndex] = useState(initial);

  if (levels.length === 0) return null;

  return (
    <div className="mt-2">
      <GalleryRail
        count={levels.length}
        activeIndex={index}
        onIndexChange={setIndex}
        reduced={reduced}
      >
        {(i) => (
          <LevelCard
            // GalleryRail only calls children(i) for 0 <= i < count, and
            // count is levels.length, so this index is always in range
            // (same non-null pattern as RevealStage's cardAt).
            level={levels[i]!}
            prevThreshold={i > 0 ? levels[i - 1]!.threshold : 0}
            highestLevel={highestLevel}
            spend={spend}
          />
        )}
      </GalleryRail>
    </div>
  );
}
