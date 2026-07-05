// src/app/slots/[slug]/CardTile.tsx
'use client';

// A reel cell as a BARE pixel Pokémon sprite (spec decision #17, supersedes
// #11's white mini-card look): no white face/border/shadow chrome — the box
// stays CARD_ASPECT-shaped (same geometry VaultReelColumn measures for the
// morph) but renders transparent, and the sprite fills most of it. The landed
// rarity treatment lives on the card-frame landing zone now, NOT the sprite
// (spec decision #34 — the card glows, the Pokémon doesn't).
import { CARD_ASPECT } from '@/lib/vault-reel';
import { PokemonToken } from './PokemonToken';

export function CardTile({
  dex,
  name,
  size,
  eager,
  imageSrc,
}: {
  dex: number;
  name: string;
  size: number;
  eager: boolean;
  imageSrc?: string;
}) {
  // Same aspect as the slab — required for the shape-synced reveal morph.
  const cardH = size;
  const cardW = Math.round(cardH * CARD_ASPECT);
  return (
    <div
      className="relative flex items-center justify-center"
      style={{
        width: `${cardW}px`,
        height: `${cardH}px`,
      }}
    >
      <PokemonToken
        dex={dex}
        name={name}
        tier="common"
        size={Math.round(size * 0.88)}
        landed={false}
        reduced
        eager={eager}
        imageSrc={imageSrc}
      />
    </div>
  );
}
