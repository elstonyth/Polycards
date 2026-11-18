import { z } from './zod';
import { finite, listOf } from './shared';

/** GET /store/vault item — pull_id + card.name + finite buyback.amount/percent.
 *  `percent` is required (mirrors OpenBuybackSchema): the sell modal renders it
 *  as the customer commits, so a dropped field must drop the row, not show NaN%. */
export const VaultItemSchema = z.looseObject({
  pull_id: z.string(),
  showcased: z.boolean().optional(),
  card: z.looseObject({ name: z.string() }),
  // How the pull was acquired, and whether it is sell/deliver locked (the free
  // welcome pull before the account's first PAID open). `.catch` rather than
  // required: a cached/older payload must keep parsing, because parseList DROPS
  // a failing row — which would delete the customer's card from their own
  // vault. `locked` defaults FALSE for the same reason (a stuck lock is worse
  // than a late one; the backend refuses the sell either way).
  // ⚠ Lock UI keys off `locked` ONLY, never `source`: a weekly-challenge prize
  // is source='reward' with a live, sellable quote. 'gift' (a vault pack) and
  // 'bonus' (paid with bonus credit) since 2026-10-07.
  source: z.enum(['pack', 'reward', 'free', 'gift', 'bonus']).catch('pack'),
  locked: z.boolean().catch(false),
  // The backend's "can this row be SOLD" answer (since 2026-09-03 it equals
  // `!locked` — reward cards sell like any other — but the backend decides).
  // Defaults TRUE so a backend that predates the field behaves exactly as it
  // did before — the sell then refuses server-side rather than the vault
  // hiding a card the customer owns.
  sellable: z.boolean().catch(true),
  // `firm` is false when the backend priced the quote on its FX display
  // fallback — selling would be refused, so the UI must not offer it as firm.
  // Optional: an older backend omits it (treated as firm).
  buyback: z.looseObject({
    amount: finite,
    percent: finite,
    firm: z.boolean().optional(),
    // MYR part of `amount` held for packs (the bonus-paid share, or the
    // welcome card). Optional: an older backend omits it.
    bonus: finite.optional(),
  }),
});

/** GET /store/vault — the page. `items` keeps `parseList`'s semantics (see
 *  VaultItemSchema: a failing row drops, never the customer's whole vault). */
export const VaultPageSchema = z.looseObject({
  items: listOf(VaultItemSchema),
});

/** GET /store/pulls/history row — every pull, sold and shipped ones included.
 *  Only the pull id and card name drop a row; each money figure is caught to
 *  null on its own (null = unknown, rendered '—', never RM 0.00). `status` is
 *  any string so a status added later still lists. */
export const PullHistoryItemSchema = z.looseObject({
  pull_id: z.string(),
  rolled_at: z.string().catch(''),
  pack_title: z.string().catch(''),
  challenge_prize: z.boolean().catch(false),
  lucky_draw_prize: z.boolean().catch(false),
  source: z.enum(['pack', 'reward', 'free', 'gift', 'bonus']).catch('pack'),
  status: z.string().catch(''),
  card: z.looseObject({ name: z.string() }),
  paid: finite.nullable().catch(null),
  value: finite.nullable().catch(null),
  sold_for: finite.nullable().catch(null),
  sold_at: z.string().nullable().catch(null),
});

/** GET /store/pulls/history — one page (?limit=&offset=). */
export const PullHistoryPageSchema = z.looseObject({
  items: listOf(PullHistoryItemSchema),
  has_more: z.boolean().catch(false),
});
