'use client';

import { SlabImage } from '@/components/SlabImage';
import { PokemonBadge } from '@/components/cards/PokemonBadge';
import { badgeSprite } from '@/lib/pokemon-badge-sprite';
import type { PackCard } from '@/lib/packs-data';

/**
 * Shared card grid tile (pack pool, Top Hits): slab thumb + name + "RM … est."
 * The WHOLE tile is one button — tap anywhere on touch; the "View Details"
 * pill fades in on hover AND keyboard focus (a11y included).
 */
export function CardTile({
  card,
  onOpen,
  sizes = '(max-width: 768px) 45vw, 200px',
}: {
  card: PackCard;
  onOpen: (card: PackCard) => void;
  sizes?: string;
}) {
  // The badge is the reel↔card key, and the reel states its sprite's name
  // (PokemonToken's alt). Naming it here too keeps the mapping reachable
  // without sight — it is the ONLY channel for a card whose admin-configured
  // sprite differs from its name. The button's aria-label overrides descendant
  // content, so an sr-only span inside the badge would be silently dropped;
  // it has to be spliced into the label itself. Every QA selector matches this
  // label by PREFIX, so the suffix is safe to append.
  const pokeName = badgeSprite(card).name;
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={`View details for ${card.name}${pokeName ? ` — reel sprite ${pokeName}` : ''}`}
      className="group flex w-full flex-col gap-1.5 text-left"
    >
      {/* No wrapper frame: the SlabImage already carries the tier band + halo
          (rarity color). A second rarity-colored border/glow here read as a
          doubled frame around the slab (operator, 2026-07-17). */}
      <span className="relative block w-full">
        <SlabImage
          src={card.image}
          slabSrc={card.slabImage}
          rarity={card.rarity}
          alt=""
          sizes={sizes}
          className="w-full transition-opacity duration-200 group-hover:opacity-60 group-focus-visible:opacity-60"
        />
        {/* The pixel-Pokémon this card is represented by on the slot reel. Sits
            OUTSIDE the dimming SlabImage so it stays legible under the hover
            wash — it is the reel↔card key, not part of the art. */}
        <PokemonBadge
          card={card}
          rarity={card.rarity}
          slabSrc={card.slabImage}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <span className="rounded-full bg-white px-3.5 py-1.5 text-[12px] font-bold text-neutral-950 shadow-lg">
            View Details
          </span>
        </span>
      </span>
      <span className="line-clamp-2 min-h-[2.5em] text-[12px] font-medium leading-tight text-white/80">
        {card.name}
      </span>
      {/* Only the amount is nowrap — "est." may drop to its own line so a
          six-figure value never spills past a 38%-wide rail tile. */}
      <span className="text-[13px] font-bold tabular-nums text-white">
        <span className="whitespace-nowrap">{card.value}</span>{' '}
        <span className="text-[11px] font-normal text-white/50">est.</span>
      </span>
    </button>
  );
}
