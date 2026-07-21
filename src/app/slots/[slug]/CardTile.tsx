// src/app/slots/[slug]/CardTile.tsx
'use client';

// A reel cell: a bordered GRID box (spec §2) holding one bare pixel Pokémon.
// The box glows its reward-tier color — a decoy color that flickers during the
// spin, the winner's real rarity color once its strip settles, neutral for
// faded decoys after settle (spec §5). Box stays CARD_ASPECT so the winner
// cell's measured rect still drives the tile→slab reveal morph.
import type { CSSProperties } from 'react';
import { CARD_ASPECT } from '@/lib/vault-reel';
import { PokemonToken } from './PokemonToken';
import { cn } from '@/lib/utils';

export function CardTile({
  dex,
  name,
  size,
  eager,
  imageSrc,
  glowRgb,
  lit = false,
  landed = false,
}: {
  dex: number;
  name: string;
  size: number;
  eager: boolean;
  imageSrc?: string;
  /** "r,g,b" tier color for the cell frame/glow. */
  glowRgb?: string;
  /** Show the tier glow (spinning decoy flicker, or the settled winner). */
  lit?: boolean;
  /** Winner emphasis after settle: stronger glow + slight scale. */
  landed?: boolean;
}) {
  const cardH = size;
  const cardW = Math.round(cardH * CARD_ASPECT);
  const rgb = glowRgb ?? '163, 163, 163';
  return (
    <div
      className={cn(
        'relative flex items-center justify-center rounded-xl border',
        // Only the WINNER animates its bloom. box-shadow is not composited, so
        // when the strip settled every cell (64 per strip) spent 300ms
        // repainting a 16px outer + 14px inset shadow at once — measured as the
        // long-task cluster right after the reels stop. Decoys just cut to
        // neutral; nobody is looking at them at that moment anyway.
        landed &&
          'scale-[1.06] transition-[box-shadow,border-color,transform] duration-300',
      )}
      style={
        {
          width: `${cardW}px`,
          height: `${cardH}px`,
          borderColor: lit
            ? `rgba(${rgb}, ${landed ? 1 : 0.7})`
            : 'rgba(255,255,255,0.10)',
          // Tier LIGHTING: a real colored bloom (outer + inner) so each cell
          // reads as lit by its reward tier, not just outlined. Winner blooms
          // hardest on settle.
          boxShadow: lit
            ? landed
              ? `0 0 30px 7px rgba(${rgb}, 0.85), inset 0 0 22px rgba(${rgb}, 0.5)`
              : `0 0 16px 3px rgba(${rgb}, 0.55), inset 0 0 14px rgba(${rgb}, 0.32)`
            : 'inset 0 0 8px rgba(0,0,0,0.5)',
          background: 'rgba(10,10,12,0.55)',
        } as CSSProperties
      }
    >
      <PokemonToken
        dex={dex}
        name={name}
        tier="common"
        size={Math.round(size * 0.72)}
        landed={false}
        reduced
        eager={eager}
        imageSrc={imageSrc}
      />
    </div>
  );
}
