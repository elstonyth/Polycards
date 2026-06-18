// src/app/slots/[slug]/PokemonToken.tsx
'use client';

import { useState } from 'react';
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
}: PokemonTokenProps) {
  const [src, setSrc] = useState(spriteGif(dex));
  const rgb = TIER_COLOR[tier];
  return (
    <div
      className={cn(
        'relative flex items-center justify-center rounded-2xl',
        !reduced && 'transition-transform duration-300 ease-out',
        landed && !reduced && 'scale-110',
      )}
      style={{
        width: size,
        height: size,
        boxShadow: landed
          ? `0 0 18px 4px rgba(${rgb}, 0.85), 0 0 42px 10px rgba(${rgb}, 0.45)`
          : 'none',
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={name}
        loading="lazy"
        onError={() =>
          setSrc((s) => (s === spritePng(dex) ? s : spritePng(dex)))
        }
        className="h-[80%] w-auto max-w-[80%] object-contain [image-rendering:auto]"
      />
    </div>
  );
}
