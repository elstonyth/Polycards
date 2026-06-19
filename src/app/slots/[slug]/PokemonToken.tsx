// src/app/slots/[slug]/PokemonToken.tsx
'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { spriteGif, spritePng } from '@/lib/mock/pokedex';
import { TIER_COLOR, type Tier } from '@/lib/price-tier';
import { cn } from '@/lib/utils';

type PokemonTokenProps = {
  dex: number;
  name: string;
  tier: Tier;
  /** Cell pixel size (square). Default 96. */
  size?: number;
  /** When true, the winner grows + glows (the reveal beat). */
  landed?: boolean;
  /** prefers-reduced-motion: no pulse/scale transition; static glow only. */
  reduced?: boolean;
  /** Eager-load this cell's image (winner + cells resting in the visible window). */
  eager?: boolean;
  /** Render this exact image instead of a dex sprite (non-Pokémon card fallback, §2/G5). */
  imageSrc?: string;
};

/**
 * A single Pokémon reel cell (spec §2). Animated showdown sprite with a static
 * PNG fallback (same pattern as PokedexClient's PokeSprite). On `landed`, the
 * sprite scales up and gains a glow ring colored by the card's price tier (§3).
 * Under reduced motion the glow is shown statically with no scale/pulse.
 */
export function PokemonToken({
  dex,
  name,
  tier,
  size = 96,
  landed = false,
  reduced = false,
  eager = false,
  imageSrc,
}: PokemonTokenProps) {
  const [src, setSrc] = useState(imageSrc ?? spriteGif(dex));
  // Re-sync if a recycled cell receives a new dex or image override.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- v7 false positive: deriving src from props for recycled cells (same pattern as SlotReelColumn)
    setSrc(imageSrc ?? spriteGif(dex));
  }, [dex, imageSrc]);
  const rgb = TIER_COLOR[tier];
  return (
    <div
      className={cn(
        'relative flex h-[var(--token-size)] w-[var(--token-size)] items-center justify-center rounded-2xl',
        !reduced && 'transition-transform duration-300 ease-out',
        landed && !reduced && 'scale-110',
      )}
      style={
        {
          '--token-size': `${size}px`,
          boxShadow: landed
            ? `0 0 18px 4px rgba(${rgb}, 0.85), 0 0 42px 10px rgba(${rgb}, 0.45)`
            : 'none',
        } as CSSProperties
      }
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        loading={eager ? 'eager' : 'lazy'}
        onError={() => {
          if (imageSrc) return; // no sprite fallback for a direct image override
          setSrc((s) => (s === spritePng(dex) ? s : spritePng(dex)));
        }}
        className="h-[80%] w-auto max-w-[80%] object-contain [image-rendering:auto]"
      />
    </div>
  );
}
