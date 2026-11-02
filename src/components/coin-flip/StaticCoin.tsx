import Image from 'next/image';
import type { CoinSide } from '@/lib/coin-flip';
import { cn } from '@/lib/utils';

export function StaticCoin({
  side = 'head',
  compact = false,
  className,
}: {
  side?: CoinSide;
  compact?: boolean;
  // Small sizes for chips and the side picker.
  className?: string;
}) {
  // shortcut: baked CoinScene renders; regenerate when its model or lighting changes.
  return (
    <Image
      src={`/coin-flip/coin-b-${side}.png`}
      alt=""
      aria-hidden
      width={512}
      height={512}
      sizes={
        className
          ? '48px'
          : compact
            ? '(min-width: 640px) 64px, 56px'
            : '(min-width: 640px) 192px, 160px'
      }
      loading="eager"
      className={cn(
        'object-contain',
        className ??
          cn('mx-auto', compact ? 'size-14 sm:size-16' : 'size-40 sm:size-48'),
      )}
    />
  );
}
