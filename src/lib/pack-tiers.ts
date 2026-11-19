/**
 * The slim per-tier view of a pack: what its pack page already shows a
 * logged-out visitor, by rarity, without the whole prize pool.
 *
 * One pure derivation for both surfaces: the pack page computes it from its
 * own detail, and `/api/pack-tiers/<slug>` serves it to the homepage flow
 * (`getPackTiers` in lib/data/packs.ts). Pure and isomorphic, so a client
 * component may import it.
 *
 * What it carries, and nothing else:
 * - per tier: its pull chance (null when the pack has no pull odds, or this
 *   tier has none), its card count, its value range, and for the top tiers
 *   (Immortal, Legendary, Mythical) the cards themselves, most valuable first,
 *   in the card tile's display fields only;
 * - the pack's expected value and value range, only when it has pull odds
 *   (they appear nowhere else on the page: the odds board is their only home);
 * - the pack's live price, buyback and stock.
 * Never the draw weights, never stock or cost figures, never an id beyond the
 * card handle the page already opens.
 *
 * Naming: the staff-entered odds are "pull odds" in everything a browser
 * receives (owner rule, 2026-11-20).
 */
import {
  FLAT_BUYBACK_PERCENT,
  isTicketPack,
  type Pack,
  type PackCard,
  type Rarity,
} from '@/lib/packs-data';
import {
  RARITIES,
  poolExpectedValue,
  poolValueRange,
  ticketOddsPool,
  ticketTopHits,
  tierValueRanges,
  type PoolValueRange,
} from '@/lib/packs-format';
import { isTopRarity } from '@/lib/rarity';

/** A tile's display fields: exactly what CardTile, TicketTile and the card
 *  overlay's seed read. */
export type PackTierCard = {
  handle: string;
  name: string;
  image: string;
  slabImage: string | null;
  rarity: Rarity;
  priceMyr: number | null;
  pokemonDex: number | null;
  spriteImage: string | null;
  /** A capsule's prize amount; absent on a card. */
  tickets?: number;
};

export type PackTier = {
  rarity: Rarity;
  /** Percent a pull, as entered by staff; null = none for this tier. */
  chance: number | null;
  /** Cards (or prizes) of this tier in the pack. */
  count: number;
  /** Lowest to highest value of this tier (tickets on a capsule); null when
   *  nothing in it is priced. */
  range: PoolValueRange | null;
  /** The tier's cards, most valuable first: top tiers only (and, on a capsule
   *  with no top tier, every tier, as its Top Hits shows every prize). */
  cards?: PackTierCard[];
};

export type PackLive = {
  priceMyr: number;
  /** Instant buyback percent; null on a capsule (it has none). */
  buybackPercent: number | null;
  inStock: boolean;
};

export type PackTierRows = {
  /** Rarest first: every tier with cards or a pull chance. */
  tiers: PackTier[];
  /** Expected value of one pull (average tickets on a capsule); null without
   *  pull odds or when they do not add up. */
  ev: number | null;
  /** The pack's value range; null without pull odds. */
  range: PoolValueRange | null;
};

export type PackTiers = PackTierRows & { pack: PackLive };

/** The detail fields the projection reads. `publishedOdds` is the existing
 *  in-app name of the pull odds; it is read here and handed on as `chance`. */
type DetailInput = {
  pool: readonly PackCard[];
  publishedOdds: { tiers: Partial<Record<Rarity, number>> } | null;
};

const tileOf = (c: PackCard): PackTierCard => {
  const tile: PackTierCard = {
    handle: c.handle,
    name: c.name,
    image: c.image,
    slabImage: c.slabImage,
    rarity: c.rarity,
    priceMyr: c.priceMyr,
    pokemonDex: c.pokemonDex,
    spriteImage: c.spriteImage,
  };
  if (typeof c.tickets === 'number') tile.tickets = c.tickets;
  return tile;
};

/** The tier rows, value range and expected value of a pool. */
export function packTierRows(
  detail: DetailInput,
  tickets: boolean,
): PackTierRows {
  const { pool } = detail;
  const pullOdds = detail.publishedOdds?.tiers ?? null;
  // The same sums the odds board states: card prices, or ticket amounts.
  const oddsPool = tickets ? ticketOddsPool(pool) : pool;
  const tierRanges = tierValueRanges(oddsPool);
  const shown = tickets
    ? ticketTopHits(pool)
    : pool.filter((c) => isTopRarity(c.rarity));
  const withCards = new Set<Rarity>(shown.map((c) => c.rarity));
  const counts = new Map<Rarity, number>();
  for (const c of pool) counts.set(c.rarity, (counts.get(c.rarity) ?? 0) + 1);

  const tiers = RARITIES.filter(
    (r) => (counts.get(r) ?? 0) > 0 || typeof pullOdds?.[r] === 'number',
  ).map((rarity): PackTier => {
    const chance = pullOdds?.[rarity];
    const tier: PackTier = {
      rarity,
      chance: typeof chance === 'number' ? chance : null,
      count: counts.get(rarity) ?? 0,
      range: tierRanges[rarity] ?? null,
    };
    if (withCards.has(rarity) || isTopRarity(rarity)) {
      tier.cards = shown.filter((c) => c.rarity === rarity).map(tileOf);
    }
    return tier;
  });

  return {
    tiers,
    ev: pullOdds ? poolExpectedValue(oddsPool, pullOdds) : null,
    range: pullOdds ? poolValueRange(oddsPool) : null,
  };
}

/** The live pack figures the page states. */
export const packLiveOf = (
  pack: Pick<Pack, 'prizeType' | 'priceMyr' | 'buybackPercent' | 'inStock'>,
): PackLive => ({
  priceMyr: pack.priceMyr,
  buybackPercent: isTicketPack(pack)
    ? null
    : (pack.buybackPercent ?? FLAT_BUYBACK_PERCENT),
  inStock: pack.inStock !== false,
});

/** The whole projection; null without a detail (backend down, empty pool). */
export function packTiersOf(
  pack: Pick<Pack, 'prizeType' | 'priceMyr' | 'buybackPercent' | 'inStock'>,
  detail: DetailInput | null,
): PackTiers | null {
  if (!detail) return null;
  return {
    ...packTierRows(detail, isTicketPack(pack)),
    pack: packLiveOf(pack),
  };
}

/** The pull odds the tiers carry, in the odds maths' own shape. */
export const pullOddsOf = (
  tiers: readonly PackTier[],
): Partial<Record<Rarity, number>> => {
  const out: Partial<Record<Rarity, number>> = {};
  for (const t of tiers) if (t.chance !== null) out[t.rarity] = t.chance;
  return out;
};
