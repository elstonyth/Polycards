// src/app/slots/[slug]/CardTile.tsx
'use client';

// A reel cell as a small white trading card (spec decision #11): rounded white
// face, subtle edge shading, the SAME pixel Pokémon sprite as today centered
// via PokemonToken's figure-centring. The tile uses CARD_ASPECT — identical to
// the slab — so the landed tile can morph into the slab back as ONE continuous
// shape (spec decision #16). Rarity glow appears ONLY when `landed` (after
// settle) — rarityRgb must be null before that (spoiler guard).
import { type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { CARD_ASPECT } from '@/lib/vault-reel';
import { PokemonToken } from './PokemonToken';

export function CardTile({
  dex,
  name,
  size,
  landed,
  rarityRgb,
  reduced,
  eager,
  imageSrc,
}: {
  dex: number;
  name: string;
  size: number;
  landed: boolean;
  rarityRgb: string | null;
  reduced: boolean;
  eager: boolean;
  imageSrc?: string;
}) {
  // Same aspect as the slab — required for the shape-synced reveal morph.
  const cardH = size - 10;
  const cardW = Math.round(cardH * CARD_ASPECT);
  return (
    <div
      className={cn(
        'relative flex items-center justify-center rounded-lg bg-white',
        'shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-2px_4px_rgba(0,0,0,0.12),0_2px_6px_rgba(0,0,0,0.45)]',
        !reduced && 'transition-transform duration-300 ease-out',
        landed && !reduced && 'scale-110',
      )}
      style={
        {
          width: `${cardW}px`,
          height: `${cardH}px`,
          boxShadow:
            landed && rarityRgb
              ? `0 0 18px 4px rgba(${rarityRgb}, 0.85), 0 0 42px 10px rgba(${rarityRgb}, 0.45)`
              : undefined,
        } as CSSProperties
      }
    >
      {/* faint inner frame like a card border */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-[6%] rounded-md border border-neutral-200"
      />
      <PokemonToken
        dex={dex}
        name={name}
        tier="common"
        size={Math.round(size * 0.62)}
        landed={false}
        reduced={reduced}
        eager={eager}
        imageSrc={imageSrc}
      />
    </div>
  );
}
