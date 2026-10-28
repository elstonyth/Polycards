import { z } from 'zod';

const money = z.number().finite().nonnegative();
const percent = z.number().min(0).max(100);
export const CoinFlipRoundSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['quoted', 'won', 'lost']),
  expires_at: z.iso.datetime(),
  settled_at: z.iso.datetime().nullable(),
  stake_amount: money.positive(),
  win_amount: money,
  published_win_percent: percent,
  card: z.object({
    pull_id: z.string(),
    name: z.string(),
    image: z.string().nullable(),
    grader: z.string().nullable(),
    grade: z.string().nullable(),
  }),
});
export const CoinFlipReceiptSchema = z.object({ round: CoinFlipRoundSchema });
export const CoinFlipHistorySchema = z.object({
  rounds: z.array(CoinFlipRoundSchema),
  count: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export const CoinFlipSettingsSchema = z.object({
  enabled: z.boolean(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  max_stake_amount: money.nullable(),
  published_win_percent: percent.nullable(),
});
export type CoinFlipRound = z.infer<typeof CoinFlipRoundSchema>;
export type CoinFlipSettings = z.infer<typeof CoinFlipSettingsSchema>;
export type CoinFlipHistory = z.infer<typeof CoinFlipHistorySchema>;
export type CoinFlipFailure = { ok: false; error: string; uncertain: boolean };
export const quoteIsLive = (round: CoinFlipRound, now: number) =>
  round.status === 'quoted' && Date.parse(round.expires_at) > now;
export const coinFlipPendingKey = (customerId: string) =>
  `polycards:coin-flip:${customerId}`;
