// src/app/slots/[slug]/BallToken.tsx
import Image from 'next/image';
import { cn } from '@/lib/utils';
import { ballSrc } from '@/lib/balls';
import type { Rarity } from '@/app/claw/packs-data';

// Rarity → rgb for the glow ring (matches the reveal palette).
export const RARITY_RGB: Record<Rarity, string> = {
  Legendary: '234, 179, 8',
  Epic: '217, 70, 239',
  Rare: '56, 189, 248',
  Uncommon: '52, 211, 153',
  Common: '163, 163, 163',
};

/** One reel cell: a transparent Pokéball on a dark glass cell, tinted by rarity. */
export function BallToken({
  rarity,
  w,
  highlight = false,
  src,
}: {
  rarity: Rarity;
  w?: number;
  highlight?: boolean;
  /** Override the image (e.g. a decoy); defaults to the rarity's ball. */
  src?: string;
}) {
  const rgb = RARITY_RGB[rarity];
  const size = w ?? 124;
  return (
    <div className="shrink-0 px-1.5" style={{ width: size }}>
      <div
        className={cn(
          'relative grid aspect-square place-items-center overflow-hidden rounded-2xl border bg-neutral-900 p-2 transition-shadow',
        )}
        style={{
          borderColor: `rgba(${rgb},0.55)`,
          boxShadow: highlight
            ? `0 0 30px -2px rgba(${rgb},0.9)`
            : `0 0 16px -8px rgba(${rgb},0.6)`,
        }}
      >
        <Image
          src={src ?? ballSrc(rarity)}
          alt=""
          aria-hidden
          width={size}
          height={size}
          className="h-[82%] w-[82%] object-contain"
        />
      </div>
    </div>
  );
}
