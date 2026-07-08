import { toMoney } from './money';
import type { CardLike } from './card-view';
import { DEFAULT_MARKET_MULTIPLIER, displayMarketPrice } from './pricing';

// The admin Gacha-Cards DTO: the public card fields plus the operator-only
// `price` (raw stored sentinel — null = "use FMV", which the edit form
// preserves) and the `for_sale` flag. Distinct from toCardView (no rarity;
// carries price/for_sale instead) — adopted by the admin card list + detail
// routes. `stock` is deliberately NOT part of this shape: the list route
// spreads it on top, and the detail route never returns it.
export type AdminCardLike = CardLike & {
  price: unknown;
  for_sale: boolean;
  pokemon_dex: number | null;
  sprite_image: string | null;
  pc_product_id: string | null;
  pc_grade: string | null;
  market_multiplier: unknown;
  pc_synced_at: Date | string | null;
};

// `fxRate` is optional so existing callers/tests that only need the base DTO
// (no FX resolved) keep the exact same shape. Admin routes pass it, adding a
// `priceBreakdown` block: raw stored USD, the fx rate used, the FMV at 1x
// (no markup), the display price (with the card's own multiplier), and the
// markup difference between the two.
export function toAdminCardDto(card: AdminCardLike, fxRate?: number) {
  const base = {
    handle: card.handle,
    name: card.name,
    set: card.set,
    grader: card.grader,
    grade: card.grade,
    market_value: toMoney(card.market_value),
    image: card.image,
    // Baked graded-slab composite (null for raw cards) — the admin thumbnails
    // prefer it over the bare photo so graded cards render framed.
    slab_image: card.slab_image ?? null,
    price: card.price === null ? null : toMoney(card.price),
    for_sale: card.for_sale,
    pokemon_dex: card.pokemon_dex ?? null,
    sprite_image: card.sprite_image ?? null,
    pc_product_id: card.pc_product_id ?? null,
    pc_grade: card.pc_grade ?? null,
    market_multiplier: toMoney(
      card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER,
    ),
    pc_synced_at: card.pc_synced_at ?? null,
  };
  if (fxRate === undefined) return base;

  const raw = toMoney(card.market_value);
  const mult = toMoney(card.market_multiplier ?? DEFAULT_MARKET_MULTIPLIER);
  const marketMyr = displayMarketPrice(raw, fxRate, 1);
  const displayPrice = displayMarketPrice(raw, fxRate, mult);
  return {
    ...base,
    priceBreakdown: {
      raw,
      fxRate,
      marketMyr,
      displayPrice,
      markup: Math.round((displayPrice - marketMyr) * 100) / 100,
    },
  };
}
