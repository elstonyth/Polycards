// src/app/slots/[slug]/BallToken.tsx
import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import type { Rarity } from '@/app/claw/packs-data';

// Rarity → rgb. Matches the existing reveal palette (PackOpenOverlay.tsx:41-47)
// — co-located per the repo's established pattern (each surface defines its own).
export const RARITY_RGB: Record<Rarity, string> = {
  Legendary: '234, 179, 8',
  Epic: '217, 70, 239',
  Rare: '56, 189, 248',
  Uncommon: '52, 211, 153',
  Common: '163, 163, 163',
};

/**
 * One reel cell: a glass-cased Pokéball tinted by rarity. Seeded default art for
 * the x1 slice — the admin Ball entity (follow-up plan) will swap the SVG for
 * `ball.image`. Cosmetic only: the rarity is decided server-side (PRD §8).
 */
export function BallToken({
  rarity,
  w,
  highlight = false,
}: {
  rarity: Rarity;
  w?: number;
  highlight?: boolean;
}) {
  const rgb = RARITY_RGB[rarity];
  return (
    <div
      className="w-[var(--bw)] shrink-0 px-1.5"
      style={{ '--ball': rgb, '--bw': w ? `${w}px` : '100%' } as CSSProperties}
    >
      <div
        className={cn(
          'relative aspect-square overflow-hidden rounded-2xl border border-[rgba(var(--ball),0.55)] bg-neutral-900 p-3 transition-shadow',
          highlight
            ? 'shadow-[0_0_30px_-2px_rgba(var(--ball),0.9)]'
            : 'shadow-[0_0_16px_-8px_rgba(var(--ball),0.6)]',
        )}
      >
        <svg viewBox="0 0 100 100" className="h-full w-full" aria-hidden>
          {/* white base */}
          <circle cx="50" cy="50" r="46" fill="#f5f5f5" />
          {/* tinted top half */}
          <path d="M4 50a46 46 0 0 1 92 0Z" fill={`rgb(${rgb})`} />
          {/* center band */}
          <rect x="4" y="46" width="92" height="8" fill="#171717" />
          {/* center button */}
          <circle cx="50" cy="50" r="13" fill="#171717" />
          <circle cx="50" cy="50" r="8" fill="#f5f5f5" />
          <circle cx="50" cy="50" r="4" fill={`rgb(${rgb})`} />
          {/* outer ring */}
          <circle
            cx="50"
            cy="50"
            r="46"
            fill="none"
            stroke="#171717"
            strokeWidth="3"
          />
        </svg>
      </div>
    </div>
  );
}
