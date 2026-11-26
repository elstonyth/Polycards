'use client';

import { SlabImage } from '@/components/SlabImage';
import { PokemonBadge } from '@/components/cards/PokemonBadge';
import { badgeSprite } from '@/lib/pokemon-badge-sprite';
import { rarityRgb } from '@/lib/rarity';
import { rm } from '@/lib/format';
import type { PackCard } from '@/lib/packs-data';

/** "02": a card's place in the value order, two digits so a strip lines up. */
export const rankLabel = (rank: number): string =>
  String(rank).padStart(2, '0');

/**
 * What a card tile's button is called: the card, its tier, its value, then its
 * reel sprite. An aria-label REPLACES the tile's content for a screen reader,
 * so everything the tile prints has to be in it, and in the order it is
 * printed: voice control matches a control by the words on it. A tile's markup
 * therefore runs name, tier, value (CSS `order` sets the look), and its two
 * decorations (the place number, the hover pill) are drawn by CSS, not text.
 *
 * The badge is the reel↔card key, and the reel states its sprite's name
 * (PokemonToken's alt). Naming it here too keeps the mapping reachable without
 * sight: it is the ONLY channel for a card whose admin-configured sprite
 * differs from its name. Every QA selector matches this label by PREFIX
 * ("View details for <name>").
 */
export const cardTileLabel = (card: PackCard, pokemon?: boolean): string => {
  const pokeName = badgeSprite(card, false, pokemon).name;
  const value = card.priceMyr != null ? rm(card.priceMyr) : '—';
  return `View details for ${card.name}, ${card.rarity}, ${value} est.${pokeName ? ` — reel sprite ${pokeName}` : ''}`;
};

/**
 * Pack-pool card tile (Top Hits strip and its by-rarity dialog): a small
 * double-bezel tray holding the card's place and tier, its slab, name and
 * "RM … est." The WHOLE tile is one button; a "View Details" pill fades in on
 * hover and on keyboard focus.
 *
 * The slab's tier halo is clipped by the plate, so each tile is lit from
 * inside by its own card's tier and nothing bleeds onto its neighbours.
 */
export function CardTile({
  card,
  onOpen,
  sizes = '(max-width: 768px) 45vw, 200px',
  pokemon,
  rank,
}: {
  card: PackCard;
  onOpen: (card: PackCard) => void;
  sizes?: string;
  /** false in a non-Pokémon pack (isPokemonPack) — see PokemonBadge. */
  pokemon?: boolean;
  /** The card's place in the value order; absent where the tiles aren't ranked. */
  rank?: number;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={cardTileLabel(card, pokemon)}
      className="group block h-full w-full rounded-[1.5rem] bg-white/[0.04] p-1 text-left outline-none ring-1 ring-white/10 transition-[background-color,transform] duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-0.5 hover:bg-white/[0.07] focus-visible:ring-2 focus-visible:ring-white/50 active:translate-y-0 active:scale-[0.99] motion-reduce:transition-none motion-reduce:hover:translate-y-0 motion-reduce:active:scale-100"
    >
      {/* Markup order is the label's order (name, tier, value); `order-*`
          puts the tier line on top and the slab under it. */}
      <span className="flex h-full flex-col gap-2.5 overflow-hidden rounded-[calc(1.5rem-0.25rem)] bg-neutral-950 p-3 shadow-[inset_0_1px_1px_rgba(255,255,255,0.12)]">
        <span className="order-3 mt-auto line-clamp-2 min-h-[2.5em] text-[12px] font-medium leading-tight text-neutral-300">
          {card.name}
        </span>
        {/* A real space: read as text, these words must not run together. */}{' '}
        <span className="order-1 flex items-center justify-between gap-2">
          {/* The place number is CSS-drawn: it is an order, not a fact about
              the card, and it is not in the label. */}
          <span
            data-rank={rank != null ? rankLabel(rank) : undefined}
            className="font-heading text-xs font-bold tabular-nums text-neutral-400 before:content-[attr(data-rank)]"
          />
          {/* The tier's name stays neutral: Rare's blue is too dark to read as
              11px text. The dot carries the hue. */}
          <span className="flex items-center gap-1.5 text-[11px] font-medium text-neutral-300">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: `rgb(${rarityRgb(card.rarity)})` }}
            />
            {card.rarity}
          </span>
        </span>{' '}
        {/* Only the amount is nowrap — "est." may drop to its own line so a
            six-figure value never spills past a narrow tile. */}
        <span className="order-4 -mt-1.5 font-heading text-sm font-bold tabular-nums text-white">
          {/* Unpriced (an older backend sent no MYR price) reads '—', never a
              raw USD number or RM 0.00. */}
          <span className="whitespace-nowrap">
            {card.priceMyr != null ? rm(card.priceMyr) : '—'}
          </span>{' '}
          <span className="font-sans text-[11px] font-normal text-neutral-400">
            est.
          </span>
        </span>
        {/* data-tile-art: the homepage flow sizes the slab to its room. */}
        <span data-tile-art="" className="relative order-2 block w-full px-1.5">
          <span className="relative block w-full">
            <SlabImage
              card={card}
              // Decorative: the button's own aria-label names the card.
              alt=""
              sizes={sizes}
              glowScale={0.6}
              className="w-full transition-opacity duration-300 group-hover:opacity-60 group-focus-visible:opacity-60"
            />
            {/* The pixel-Pokémon this card is represented by on the slot reel.
                Sits OUTSIDE the dimming SlabImage so it stays legible under the
                hover wash: it is the reel↔card key, not part of the art. */}
            <PokemonBadge
              card={card}
              rarity={card.rarity}
              slabSrc={card.slabImage}
              pokemon={pokemon}
              decorative
            />
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-300 group-hover:opacity-100 group-focus-visible:opacity-100"
            >
              <span className="rounded-full bg-white px-3.5 py-1.5 text-[12px] font-bold text-neutral-950 before:content-['View_Details']" />
            </span>
          </span>
        </span>
      </span>
    </button>
  );
}
