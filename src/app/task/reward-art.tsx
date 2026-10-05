import Image from 'next/image';
import { Gift } from 'lucide-react';
import { cn } from '@/lib/utils';
import { rm, rm0 } from '@/lib/format';
import { priceTier, TIER_COLOR } from '@/lib/price-tier';
import type { TaskEntry } from '@/lib/data/schemas';
import { rewardArt, rewardLabel } from './task-hub';

// A four-point star — the sparkle's one shape.
const STAR =
  'M12 0C13 7 17 11 24 12C17 13 13 17 12 24C11 17 7 13 0 12C7 11 11 7 12 0Z';

// Where the stars sit around the art, as % of the box, with their size and
// twinkle offset — staggered so they never all flash at once.
const STARS = [
  { pos: '-left-1.5 -top-1.5', size: 'h-3 w-3', delay: '0s' },
  { pos: '-right-2 top-1/4', size: 'h-2.5 w-2.5', delay: '0.6s' },
  { pos: '-bottom-1 left-1/3', size: 'h-2 w-2', delay: '1.1s' },
  { pos: '-right-1 -bottom-2', size: 'h-3.5 w-3.5', delay: '1.5s' },
] as const;

/** Gold stars twinkling around a claimable reward. Decorative: the Claim
 *  button and the row's text carry the meaning. */
export function Sparkles({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('pointer-events-none absolute inset-0', className)}
    >
      {STARS.map((s) => (
        <svg
          key={s.pos}
          viewBox="0 0 24 24"
          className={cn('claim-star absolute fill-[#ffe2a3]', s.pos, s.size)}
          style={{ '--twinkle-delay': s.delay } as React.CSSProperties}
        >
          <path d={STAR} />
        </svg>
      ))}
    </span>
  );
}

/**
 * The prize itself, on a neutral pedestal: the card's graded slab (lit by its
 * own value tier — the glow is inherited from the card, never decorative), the
 * pack's shot, or the credit coins. The worth sits under it in Nekst, the
 * Money-Is-Display rule. Claimable = breathing gold ring + sparkles; claimed
 * = dimmed.
 */
export function RewardArt({
  reward,
  claimable = false,
  claimed = false,
  className,
  compact = false,
}: {
  reward: TaskEntry['reward'];
  claimable?: boolean;
  claimed?: boolean;
  className?: string;
  /** The check-in track's small tiles: no value badge (the tile has its own). */
  compact?: boolean;
}) {
  const src = rewardArt(reward);
  const { value } = rewardLabel(reward);
  const tierRgb =
    reward.type === 'card' && value != null
      ? TIER_COLOR[priceTier(value)]
      : null;
  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]',
        claimable && 'claim-ring border-transparent',
        claimed && 'opacity-45',
        className,
      )}
    >
      {src ? (
        <span
          className={cn(
            'relative h-[82%] w-[82%]',
            tierRgb && 'drop-shadow-[0_0_10px_rgba(var(--tier-rgb),0.55)]',
          )}
          style={
            tierRgb
              ? ({ '--tier-rgb': tierRgb } as React.CSSProperties)
              : undefined
          }
        >
          <Image
            src={src}
            alt=""
            fill
            sizes="96px"
            className="object-contain"
          />
        </span>
      ) : (
        <Gift className="h-1/3 w-1/3 text-neutral-500" aria-hidden />
      )}
      {!compact && value != null && value > 0 && (
        <span className="font-heading absolute -bottom-2 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-neutral-950 px-1.5 py-px text-[10px] leading-tight whitespace-nowrap text-chase tabular-nums">
          {Number.isInteger(value) ? rm0(value) : rm(value)}
        </span>
      )}
      {claimable && <Sparkles />}
    </span>
  );
}
