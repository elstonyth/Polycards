import { z } from './zod';
import { count, finite, rarity } from './shared';

/** Browser JSON is version-sensitive even on the same origin: rolling deploys
 * can answer with the older view shape. Reject incompatible data before it
 * replaces the seed/last-good view; routes separately retain old-tab aliases.
 * These schemas validate the current VIEW, not the backend Store envelope. */
const pollCard = z.object({
  handle: z.string(),
  name: z.string(),
  image: z.string(),
  slabImage: z.string().nullable(),
  rarity: rarity.nullable(),
  priceMyr: finite.nullable(),
  pokemonDex: finite.nullable(),
  spriteImage: z.string().nullable(),
});
const pollTiers = z.partialRecord(rarity, finite);
const pollOdds = z.object({ tiers: pollTiers }).nullable();
export const CardPollResponseSchema = z.object({
  card: pollCard.extend({
    priceMyr: finite,
    set: z.string(),
    grader: z.string(),
    grade: z.string(),
    pcSyncedAt: z.string().nullable(),
    priceHistory: z.array(z.object({ date: z.string(), valueMyr: finite })),
  }),
});
const pollPackCard = pollCard.extend({
  rarity,
  tickets: z.number().optional(),
});
export const PackPollResponseSchema = z.object({
  detail: z.object({
    topHits: z.array(pollPackCard),
    pool: z.array(pollPackCard),
    publishedOdds: pollOdds,
    demoOdds: pollOdds,
  }),
});
export const RecentPollResponseSchema = z.object({
  pulls: z.array(
    pollCard.extend({
      rarity,
      tickets: z.number().optional(),
      id: z.string(),
      packName: z.string(),
      packIcon: z.string(),
      who: z.string(),
      profileHandle: z.string().nullable(),
      avatar: z.string().nullable(),
      frame: z.string().nullable(),
      rolledAt: z.string(),
      agoLabel: z.string(),
    }),
  ),
  drought: pollTiers.nullish().transform((value) => value ?? {}),
});

/** GET /api/pull-gaps — the stats chart's VIEW shape (getPullGaps's return),
 *  not the backend Store envelope PullGapsSchema validates. A 200 carrying
 *  the older view (no `hits`) must land as the chart's unavailable state,
 *  never as a render-time throw through the panel's error boundary. */
export const PullGapsPollResponseSchema = z.object({
  rarity,
  pct: finite.nullable(),
  expected: finite.nullable(),
  avg: finite.nullable(),
  last20: finite.nullable(),
  current: count,
  hits: z.array(
    z.object({
      id: z.string(),
      gap: count,
      rolledAt: z.string(),
      who: z.string(),
      avatar: z.string().nullable(),
      frame: z.string().nullable(),
    }),
  ),
});
