import { z } from './zod';
import { finite, rarity } from './shared';

/** Open-route `card` — handle + name + known rarity + finite market_value.
 *  marketPriceMyr (live MYR display price) is optional — an older backend
 *  that hasn't been enriched yet simply omits it. */
export const WonCardSchema = z.looseObject({
  handle: z.string(),
  name: z.string(),
  rarity,
  market_value: finite,
  pokemon_dex: z.number().nullable().optional(),
  sprite_image: z.string().nullable().optional(),
  marketPriceMyr: finite.optional(),
});

/** Open-batch `ticket_spin`: what one reel won on a ticket pack. Only the amount
 *  can drop the roll. By now the charge has landed and the tickets are credited,
 *  so a bad tier, which only colours the tile, degrades instead. */
export const TicketSpinRollSchema = z.looseObject({
  tickets: z.number().int().positive(),
  rarity: rarity.catch('Common'),
});

/** Open-route `buyback` offer — instant percent/amount (required) + the vault
 *  rate/amount and instant deadline (optional; older backends omit them).
 *  `firm:false` = quoted on the FX display fallback; selling would be refused
 *  ("Exchange rate unavailable"), so the reveal must not present it as firm. */
export const OpenBuybackSchema = z.looseObject({
  percent: finite,
  amount: finite,
  vault_percent: finite.optional(),
  vault_amount: finite.optional(),
  instant_deadline_ms: finite.optional(),
  firm: z.boolean().optional(),
  // MYR part of `amount` held for packs (the bonus-paid share, or the welcome card).
  bonus: finite.optional(),
});
