'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { CardSeed } from '@/components/cards/CardDetailOverlay';
import { CardTile } from '@/components/cards/CardTile';
import { SectionHead } from '@/components/ui/soft';
import { isTicketPack, type Pack } from '@/lib/packs-data';
import type { PackTier, PackTierCard, PackTierRows } from '@/lib/pack-tiers';
import { rarityRgb, isTopRarity } from '@/lib/rarity';
import { isPokemonPack } from '@/lib/resolve-card-pokemon';
import { rangeLabel } from './OddsSheet';
import {
  RAIL_FIRST_TILES,
  StripArrow,
  TicketTile,
  edgeFade,
  useStrip,
} from './pool-rail';

/**
 * Top Hits as a tier walk (owner decision 2026-11-19, plan step 2 section 1):
 * one swipeable row per top tier the pack has (Immortal, Legendary, Mythical;
 * a missing tier is left out), each under its own header: the rarity dot, the
 * tier's name, its pull chance (only when the pack has pull odds), its value
 * range and its count. Lower tiers have no row here: the odds board below
 * gives them one summary row each.
 *
 * A capsule walks its ticket prizes the same way ("prizes", ticket ranges);
 * one with no top tier shows one "All prizes" row, as its Top Hits does.
 *
 * Fed by the tier projection (lib/pack-tiers), never the whole pool.
 */
export function PackTierWalk({
  pack,
  tiers,
  onOpenCard,
}: {
  pack: Pick<Pack, 'prizeType'> & { categoryId?: string };
  tiers: PackTierRows | null;
  onOpenCard: (card: CardSeed) => void;
}) {
  if (!tiers) return null;
  const tickets = isTicketPack(pack);
  const pokemon = isPokemonPack(pack.categoryId ?? '');
  const rows = walkRows(tiers.tiers, tickets);
  if (rows.length === 0) return null;
  const total = rows.reduce((n, r) => n + r.cards.length, 0);
  const noun = tickets ? 'prize' : 'card';
  return (
    <div className="flex flex-col gap-6" data-testid="pack-tier-walk">
      <SectionHead
        eyebrow={`${total} ${total === 1 ? noun : `${noun}s`}`}
        title="Top Hits"
      />
      {rows.map((row) => (
        <TierRail
          key={row.key}
          row={row}
          tickets={tickets}
          pokemon={pokemon}
          onOpenCard={onOpenCard}
        />
      ))}
    </div>
  );
}

type WalkRow = {
  key: string;
  /** The tier, or null for a capsule's "All prizes" row. */
  tier: PackTier | null;
  cards: PackTierCard[];
};

/** The rows the walk shows: each top tier with cards, rarest first; on a
 *  capsule with no top tier, one row of every prize, biggest first. */
export function walkRows(tiers: readonly PackTier[], tickets: boolean) {
  const top = tiers.filter(
    (t) => isTopRarity(t.rarity) && (t.cards?.length ?? 0) > 0,
  );
  if (top.length > 0) {
    return top.map((t): WalkRow => ({
      key: t.rarity,
      tier: t,
      cards: t.cards ?? [],
    }));
  }
  if (!tickets) return [];
  const all = tiers
    .flatMap((t) => t.cards ?? [])
    .sort((a, b) => (b.tickets ?? 0) - (a.tickets ?? 0));
  return all.length > 0 ? [{ key: 'all', tier: null, cards: all }] : [];
}

function TierRail({
  row,
  tickets,
  pokemon,
  onOpenCard,
}: {
  row: WalkRow;
  tickets: boolean;
  pokemon: boolean;
  onOpenCard: (card: CardSeed) => void;
}) {
  const { tier, cards } = row;
  const noun = tickets ? 'prize' : 'card';
  const nouns = `${noun}s`;
  const name = tier ? tier.rarity : 'All';
  const strip = useStrip<HTMLUListElement>(cards.length);
  const { edges } = strip;
  const count = tier ? tier.count : cards.length;
  return (
    <section className="flex flex-col gap-3" aria-label={`${name} ${nouns}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="flex items-center gap-2 text-base font-semibold text-white">
            {tier && (
              <span
                aria-hidden
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: `rgb(${rarityRgb(tier.rarity)})` }}
              />
            )}
            {tier ? tier.rarity : 'All prizes'}
          </h3>
          <p className="flex flex-wrap gap-x-3 text-xs tabular-nums text-neutral-400">
            {tier?.chance != null && (
              <span className="font-semibold text-white">
                {tier.chance}% a pull
              </span>
            )}
            {tier?.range && <span>{rangeLabel(tier.range, tickets)}</span>}
            <span>
              {count} {count === 1 ? noun : nouns}
            </span>
          </p>
        </div>
        {(edges.prev || edges.next) && (
          <div className="flex shrink-0 items-center gap-2">
            <StripArrow
              label={`Previous ${name} ${nouns}`}
              enabled={edges.prev}
              onClick={() => strip.step(-1)}
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            </StripArrow>
            <StripArrow
              label={`Next ${name} ${nouns}`}
              enabled={edges.next}
              onClick={() => strip.step(1)}
            >
              <ChevronRight className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            </StripArrow>
          </div>
        )}
      </div>
      <div className="-m-1.5 p-1.5" style={edgeFade(edges)}>
        <ul
          {...strip.drag}
          onScroll={strip.onScroll}
          aria-label={`${name} ${nouns}, ${cards.length}`}
          // Ticket tiles are not controls: the list takes focus and the arrow
          // keys scroll it.
          {...(tickets ? { tabIndex: 0 } : null)}
          className="-m-1 flex cursor-grab scroll-px-[3.75rem] gap-3 overflow-x-auto rounded-[1.75rem] p-1 outline-none focus-visible:ring-2 focus-visible:ring-white/40 active:cursor-grabbing [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {(strip.grown ? cards : cards.slice(0, RAIL_FIRST_TILES)).map(
            (c, i) => (
              <li
                key={c.handle}
                className="max-w-[60%] flex-[1_0_44%] sm:max-w-[16rem] sm:flex-[1_0_10rem]"
              >
                {tickets ? (
                  <TicketTile card={c} rank={i + 1} />
                ) : (
                  <CardTile
                    card={c}
                    sizes="(max-width: 640px) 140px, 160px"
                    onOpen={onOpenCard}
                    pokemon={pokemon}
                    rank={i + 1}
                  />
                )}
              </li>
            ),
          )}
        </ul>
      </div>
    </section>
  );
}
