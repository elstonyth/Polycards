'use client';

import { SlabImage } from '@/components/SlabImage';
import { rarityRgb } from '@/lib/rarity';
import type { PackCard } from '@/lib/packs-data';

/**
 * Shared card grid tile (pack pool, Top Hits): slab thumb + name + "RM … est."
 * The WHOLE tile is one button — tap anywhere on touch; the "View Details"
 * pill fades in on hover AND keyboard focus (phygitals parity, a11y included).
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
  const rgb = rarityRgb(card.rarity);
  return (
    <button
      type="button"
      onClick={() => onOpen(card)}
      aria-label={`View details for ${card.name}`}
      className="group flex w-full flex-col gap-1.5 text-left"
    >
      <span
        className="relative block w-full overflow-hidden rounded-xl border bg-neutral-900 p-1.5"
        style={{
          borderColor: `rgba(${rgb},0.55)`,
          boxShadow: `0 0 16px -8px rgba(${rgb},0.6)`,
        }}
      >
        <SlabImage
          src={card.image}
          slabSrc={card.slabImage}
          alt=""
          sizes={sizes}
          className="w-full transition-opacity duration-200 group-hover:opacity-60 group-focus-visible:opacity-60"
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
      <span className="whitespace-nowrap text-[13px] font-bold tabular-nums text-white">
        {card.value}{' '}
        <span className="text-[11px] font-normal text-white/50">est.</span>
      </span>
    </button>
  );
}
