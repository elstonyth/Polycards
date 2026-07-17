'use client';

import type { PackCard, Rarity } from '@/lib/packs-data';
import { rarityRgb, RARITY_ORDER } from '@/lib/rarity';
import { isRarity } from '@/lib/packs-format';
import { CardTile } from '@/components/cards/CardTile';

/**
 * "Cards in this pack" as rarity shelves: the pool grouped by canonical tier
 * (rarest first), each tier one horizontally-swipeable rail — the catalog's
 * shelf idiom — so a 40-common pool costs one row, not fourteen. Headers
 * carry the rarity dot + count and, when the admin published odds, that
 * tier's pull chance (the same data the odds panel shows; nothing invented).
 */
export function PoolByRarity({
  pool,
  tierChances,
  onOpen,
}: {
  /** Full public prize pool, value-sorted (order kept within each tier). */
  pool: PackCard[];
  /** Admin-published per-tier chances; null = this pack has no published odds. */
  tierChances: Partial<Record<Rarity, number>> | null;
  onOpen: (card: PackCard) => void;
}) {
  // Bucket by canonical tier; unknown backend rarity strings read as Common
  // (the same tolerance as rarityRgb) so no card can vanish from the pool.
  const groups = RARITY_ORDER.map((rarity) => ({
    rarity,
    cards: pool.filter((c) =>
      isRarity(c.rarity) ? c.rarity === rarity : rarity === 'Common',
    ),
  })).filter((g) => g.cards.length > 0);

  return (
    <div className="flex flex-col gap-5">
      {groups.map(({ rarity, cards }) => {
        const rgb = rarityRgb(rarity);
        return (
          <section key={rarity} aria-label={`${rarity} cards`}>
            <div className="mb-2 flex items-baseline gap-2">
              <span
                aria-hidden
                className="h-2.5 w-2.5 self-center rounded-full"
                style={{ background: `rgb(${rgb})` }}
              />
              <h3 className="text-[13px] font-semibold text-white">{rarity}</h3>
              <span className="text-[12px] tabular-nums text-white/50">
                {cards.length} {cards.length === 1 ? 'card' : 'cards'}
              </span>
              {typeof tierChances?.[rarity] === 'number' && (
                <span className="ml-auto text-[12px] tabular-nums text-white/60">
                  {tierChances[rarity]}% pull chance
                </span>
              )}
            </div>
            {/* Rail — a peeking partial card signals the sideways swipe;
                hidden scrollbar matches the catalog rails. overflow-x-auto
                forces overflow-y to compute to `auto` (CSS coupling), which
                would clip each slab's tier halo (box-shadow) top/bottom; the
                py/-my pair gives the glow room inside the scroll box without
                changing layout. */}
            <div className="-my-8 flex gap-2 overflow-x-auto py-8 sm:gap-3 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {cards.map((c) => (
                <div key={c.id} className="w-[38%] shrink-0 sm:w-40">
                  <CardTile
                    card={c}
                    sizes="(max-width: 640px) 38vw, 160px"
                    onOpen={onOpen}
                  />
                </div>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
