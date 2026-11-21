import { z } from './zod';
import { count, droppableArray, finite, rarity } from './shared';

/** What a pack pays. Absent on an older backend; an unknown value reads as
 *  cards rather than dropping the pack. */
const prizeType = z.enum(['cards', 'tickets']).catch('cards').optional();

/** GET /store/packs row — getter checks `category` + finite `price` only. */
export const PackRowSchema = z.looseObject({
  category: z.string(),
  price: finite,
  prize_type: prizeType,
  /** §2.4.8 pool composition, backend-derived (GRADED = every card graded,
   *  RAW = none, MIX = both, null = empty pool). Absent on an older backend;
   *  a malformed value degrades to null rather than dropping the pack row. */
  group: z.enum(['GRADED', 'RAW', 'MIX']).nullable().catch(null).optional(),
  /** Strict guarantee gate: true iff EVERY pooled card is a PSA 10 (stricter
   *  than group === 'GRADED' — a PSA 9 or a BGS slab is graded but not psa10).
   *  Malformed/absent degrades to false: never overclaim the guarantee. */
  psa10: z.boolean().catch(false).optional(),
  /** Admin tags (#894). Absent on an older backend; an unknown value degrades
   *  to null (an untagged pack) rather than dropping the pack row. */
  pack_type: z
    .enum(['classic', 'original', 'special'])
    .nullable()
    .catch(null)
    .optional(),
  language: z.enum(['en', 'jp']).nullable().catch(null).optional(),
});

/** GET /store/packs — the catalog list. `droppableArray`, not `listOf`: a bad
 *  ROW drops on its own, but a non-array `packs` must FAIL the parse. That is
 *  a malformed 200 (deploy skew, a proxy error page, a schema rename), and
 *  this loader lives inside `cached()` — reading it as empty would memoise an
 *  all-empty catalog for the window instead of evicting. */
export const PacksPageSchema = z.looseObject({
  packs: droppableArray(PackRowSchema),
});

/** GET /store/packs/:slug as data/packs.ts#getUncatalogedPack reads it — the
 *  same runtime guard the list path applies, on the single row. */
export const UncatalogedPackSchema = z.looseObject({ pack: PackRowSchema });

/** GET /store/packs/:slug odds row — handle + known rarity + finite value.
 *  marketPriceMyr (live MYR display price: FMV × FX × margin, computed by the
 *  backend at request time) is optional — an older backend without it falls
 *  back to the raw USD market_value. */
export const OddsEntrySchema = z.looseObject({
  handle: z.string(),
  rarity,
  market_value: finite,
  marketPriceMyr: finite.optional(),
  /** Admin-picked Top Hit display order (1-based; null/absent = not one).
   *  Malformed values degrade to null instead of dropping the whole row. */
  top_hit_order: z.number().int().positive().nullable().catch(null).optional(),
  /** The card's configured pixel-Pokémon (mirror of its linked library entry);
   *  a malformed value degrades to null so the reel falls back to name-derive. */
  pokemon_dex: z.number().int().positive().nullable().catch(null).optional(),
  sprite_image: z.string().nullable().catch(null).optional(),
});

/** GET /store/packs/:slug odds row on a ticket pack: one per amount, with its
 *  tier and, like a card row, no weight. */
export const TicketOddsRowSchema = z.looseObject({
  tickets: z.number().int().positive(),
  rarity,
});

/** GET /store/packs/:slug as data/packs.ts#getPackDetail reads it.
 *
 *  `pull_odds` stays UNVALIDATED here on purpose: it is jsonb
 *  passthrough, and parsePullOdds sanitizes it field by field
 *  (dropping unknown tiers and out-of-range percentages) rather than
 *  rejecting the whole response over one bad number. `odds` is a
 *  droppableArray for the same reason as the catalog: a bad row drops, a
 *  non-array response does not read as "this pack has no pool". */
export const PackDetailPageSchema = z.looseObject({
  odds: droppableArray(z.union([OddsEntrySchema, TicketOddsRowSchema])),
  prize_type: prizeType,
  pull_odds: z.unknown().optional(),
});

/** GET /store/pulls/recent row — handle + name + known rarity + finite value.
 *  marketPriceMyr optional, same contract as the odds row above. */
export const RecentPullSchema = z.looseObject({
  handle: z.string(),
  name: z.string(),
  rarity,
  market_value: finite,
  marketPriceMyr: finite.optional(),
  // The puller's public display fields (2026-09-02, pull-history panel) —
  // the leaderboard's own PII-safe set. All optional (this schema is no
  // stricter than the getter's old checks): an older backend still renders a
  // row, just faceless.
  id: z.string().optional(),
  seed: finite.optional(),
  profile_handle: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
  frame_url: z.string().nullable().optional(),
});

/** A ticket pack's row in that feed: the amount won in place of a card. */
export const RecentTicketSpinSchema = RecentPullSchema.omit({
  handle: true,
  name: true,
  market_value: true,
  marketPriceMyr: true,
}).extend({ tickets: z.number().int().positive() });

/** GET /store/pulls/recent — the feed. `drought` stays unvalidated here: the
 *  getter walks it entry by entry against the known tiers, so one bad counter
 *  costs its own counter, not the feed. Rows drop one at a time; a non-array
 *  `pulls` fails, which is the getter's empty-feed answer. */
export const RecentPullsPageSchema = z.looseObject({
  pulls: droppableArray(z.union([RecentPullSchema, RecentTicketSpinSchema])),
  drought: z.unknown().optional(),
});

/** GET /store/pulls/gaps — the stats chart: a known tier, a finite current
 *  drought, and hits with finite gaps. The header numbers are optional
 *  nullables (no rate on the global feed, no mean with no hits). */
export const PullGapsSchema = z.looseObject({
  rarity,
  current: count,
  pct: finite.nullable().optional(),
  expected: finite.nullable().optional(),
  avg: finite.nullable().optional(),
  last20: finite.nullable().optional(),
  hits: z.array(
    z.looseObject({
      id: z.string(),
      gap: count,
      rolled_at: z.string(),
      who: z.string().optional(),
      seed: finite.nullable().optional(),
      profile_handle: z.string().nullable().optional(),
      avatar_url: z.string().nullable().optional(),
      frame_url: z.string().nullable().optional(),
    }),
  ),
});
