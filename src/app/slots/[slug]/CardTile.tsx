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
        'transition-[box-shadow,border-color,transform] duration-300',
        landed && 'scale-[1.06]',
      )}
      style={
        {
          width: `${cardW}px`,
          height: `${cardH}px`,
          borderColor: lit
            ? `rgba(${rgb}, ${landed ? 0.95 : 0.55})`
            : 'rgba(255,255,255,0.10)',
          boxShadow: lit
            ? landed
              ? `0 0 18px 3px rgba(${rgb}, 0.7), inset 0 0 14px rgba(${rgb}, 0.35)`
              : `0 0 10px 1px rgba(${rgb}, 0.35), inset 0 0 8px rgba(${rgb}, 0.18)`
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
