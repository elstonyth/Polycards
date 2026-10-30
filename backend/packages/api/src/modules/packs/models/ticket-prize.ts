import { model } from '@medusajs/framework/utils';

// TicketPrize — a ticket pack's table (spec 2026-10-30): one row per amount of
// Lucky Draw tickets a spin can win. Same rate columns and units as pack_odds
// (1,000,000 = 100%, NULL set = inherit the previous set), so @acme/odds-math and
// odds-sets.ts work unchanged.
//
// Not pack_odds rows on purpose: a fake card would leak into the vault, sell-back,
// delivery, stock and every other reader of cards.
export const TicketPrize = model
  .define('ticket_prize', {
    id: model.id({ prefix: 'tkpz' }).primaryKey(),
    pack_id: model.text(), // = Pack.slug
    // At least 1: a hand-written CHECK holds that (Migration20261030100000).
    tickets: model.number(),
    rarity: model.enum([
      'Immortal',
      'Legendary',
      'Mythical',
      'Rare',
      'Uncommon',
      'Common',
    ]),
    weight: model.number(),
    weight_2: model.number().nullable(),
    weight_3: model.number().nullable(),
    locked: model.boolean().default(false),
  })
  .indexes([
    {
      name: 'UQ_ticket_prize_pack_tickets',
      on: ['pack_id', 'tickets'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default TicketPrize;
