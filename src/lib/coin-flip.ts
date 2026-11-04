import { z } from '@/lib/data/schemas';
import { num } from '@/lib/format';

const money = z.number().finite().nonnegative();
const percent = z.number().min(0).max(100);
export const COIN_FLIP_MAX_CARDS = 20;
export const COIN_FLIP_MAX_TICKETS = 10_000;
export const COIN_FLIP_QUOTE_MS = 60_000;
export const coinFlipTicketsLabel = (tickets: number) =>
  `${num(tickets)} ${tickets === 1 ? 'ticket' : 'tickets'}`;
export const coinFlipTicketsGone = (tickets: number) =>
  tickets === 1
    ? 'The ticket you flipped is gone.'
    : `All ${num(tickets)} tickets you flipped are gone.`;
export const CoinSideSchema = z.enum(['head', 'tail']);
export type CoinSide = z.infer<typeof CoinSideSchema>;
export const coinSideLabel = (side: CoinSide) =>
  side === 'head' ? 'Head' : 'Tail';
const card = z.object({
  pull_id: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  grader: z.string().nullable(),
  grade: z.string().nullable(),
});
export const CoinFlipRoundSchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['quoted', 'won', 'lost']),
    expires_at: z.iso.datetime(),
    settled_at: z.iso.datetime().nullable(),
    stake_amount: money,
    win_amount: money,
    published_win_percent: percent,
    card: card.nullable(),
    cards: z
      .array(card.extend({ stake_amount: money.positive() }))
      .max(COIN_FLIP_MAX_CARDS),
    // Lucky Draw tickets staked; 0 when none. They never pay or cost money.
    tickets: z.number().int().min(0).max(COIN_FLIP_MAX_TICKETS).default(0),
    chosen_side: CoinSideSchema,
    landed_side: CoinSideSchema.nullable(),
  })
  .refine(
    (round) =>
      (round.cards.length > 0
        ? round.card !== null &&
          round.stake_amount > 0 &&
          new Set(round.cards.map((card) => card.pull_id)).size ===
            round.cards.length &&
          round.cards.reduce(
            (sum, card) => sum + Math.round(card.stake_amount * 100),
            0,
          ) === Math.round(round.stake_amount * 100)
        : round.tickets > 0 &&
          round.card === null &&
          round.stake_amount === 0 &&
          round.win_amount === 0) &&
      // A receipt that disagrees with itself is not shown as money.
      Math.round(round.win_amount * 100) ===
        (round.status === 'won' ? Math.round(round.stake_amount * 100) : 0) &&
      (round.settled_at === null) === (round.status === 'quoted') &&
      (round.status === 'quoted'
        ? round.landed_side === null
        : round.landed_side ===
          (round.status === 'won'
            ? round.chosen_side
            : round.chosen_side === 'head'
              ? 'tail'
              : 'head')),
    'Inconsistent coin flip receipt',
  );
export const CoinFlipReceiptSchema = z.object({ round: CoinFlipRoundSchema });
export const CoinFlipHistorySchema = z.object({
  rounds: z.array(CoinFlipRoundSchema),
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
  // How every flip the customer made landed, whatever the rows are filtered by.
  totals: z.object({
    head: z.number().int().nonnegative(),
    tail: z.number().int().nonnegative(),
  }),
});
// Every player's latest settled flips (the page's Everyone view), each with
// the player's public display fields, as the Just Pulled feed shows them.
export const CoinFlipFeedSchema = z.object({
  rounds: z.array(
    CoinFlipRoundSchema.and(
      z.object({
        who: z.string(),
        seed: z.number().nullable(),
        avatar_url: z.string().nullable(),
        frame_url: z.string().nullable(),
      }),
    ),
  ),
});
export const CoinFlipSettingsSchema = z.object({
  enabled: z.boolean(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  published_win_percent: percent.nullable(),
});
export type CoinFlipRound = z.infer<typeof CoinFlipRoundSchema>;
export type CoinFlipSettings = z.infer<typeof CoinFlipSettingsSchema>;
export type CoinFlipHistory = z.infer<typeof CoinFlipHistorySchema>;
export type CoinFlipFeedRound = z.infer<
  typeof CoinFlipFeedSchema
>['rounds'][number];
export type CoinFlipHistoryFilter = 'all' | 'won' | 'lost';
export type CoinFlipFailure = {
  ok: false;
  error: string;
  uncertain: boolean;
  missing?: boolean;
};
export const quoteIsLive = (round: CoinFlipRound, now: number) =>
  round.status === 'quoted' && Date.parse(round.expires_at) > now;
export const coinFlipPendingKey = (customerId: string) =>
  `polycards:coin-flip:${customerId}`;
