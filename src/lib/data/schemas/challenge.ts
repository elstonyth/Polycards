import { z } from './zod';
import { droppableArray, droppableRecord, finite } from './shared';

/** GET /store/challenge — the Weekly Challenge structure. This seam is
 *  display-only (pool / standings / summary — no sell path), so it FAILS OPEN:
 *  only `active` + `settings` are hard-required; every other section degrades
 *  gracefully so a single malformed row/section can't blank the challenge block.
 *  A malformed `stage`/`top` row is DROPPED (survivors kept, mirroring
 *  `parseList`); a malformed `cards` entry is dropped; a malformed `progress`
 *  degrades to absent (pool/summary hide). Only `active:false`, an empty stage
 *  list, or a broken `active`/`settings` makes the seam return null → the
 *  page's "launching soon" empty state. `cards` maps card ids to a thumbnail. */
export const ChallengeSchema = z.looseObject({
  active: z.boolean(),
  /** Real community pulled-value this week (ledger aggregate). Optional for
   *  deploy skew — an older backend without it renders the page without the
   *  pool panel. `.catch(undefined)` so a MALFORMED progress also degrades to
   *  absent instead of dropping the whole challenge. */
  progress: z.looseObject({ pooledMyr: finite }).optional().catch(undefined),
  settings: z.looseObject({
    timezone: z.string(),
    resetDay: finite,
    resetHour: finite,
  }),
  /** A malformed stage is dropped, not fatal — surviving stages still render.
   *  `rankRewards` is the per-rank prize table (plan 057): SPARSE — an absent
   *  rank pays nothing, and a rank may carry a card AND/OR credits. A malformed
   *  RANK ROW drops that row only (droppableArray), a non-array table degrades
   *  to `[]`, and the whole field is optional for deploy skew (an older backend
   *  without it renders the stage with no prize tiles rather than vanishing). */
  stages: droppableArray(
    z.looseObject({
      stageNumber: finite,
      thresholdMyr: finite,
      rankRewards: droppableArray(
        z.looseObject({
          // Strict 1-10 integer: StageCarousel indexes RANKS[rank-1] with a
          // non-null assertion, so a 0 / negative / fractional rank would crash
          // the whole challenge tile. droppableArray drops the bad row instead.
          rank: z.number().int().min(1).max(10),
          cardId: z.string().nullable().catch(null),
          credits: finite,
        }),
      )
        .optional()
        .catch(undefined),
    }),
  ),
  /** A malformed card entry drops that thumbnail (getter tolerates unresolved
   *  ids), not the whole challenge. */
  cards: droppableRecord(
    z.looseObject({
      name: z.string(),
      image: z.string(),
      /** Public route key for /card/<handle>. Optional for deploy skew — an
       *  older backend omits it and the thumbnail renders without a link
       *  rather than pointing at /card/undefined. */
      handle: z.string().nullish(),
      /** The graded-slab composite when the card has one. Optional for deploy
       *  skew — an older backend omits it and the card renders unframed. */
      slab_image: z.string().nullish(),
    }),
  ),
  /** Weekly Pull Value top-10 (pulled-value ranked, PII-safe names). Optional
   *  for deploy skew — absent hides the standings section. Bad rows drop like
   *  the leaderboard's; a non-array `top` degrades to absent via `.catch`. */
  top: droppableArray(
    z.looseObject({
      rank: finite,
      name: z.string(),
      handle: z.string().nullable().optional(),
      volumeMyr: finite,
      pulls: finite,
      seed: finite,
      avatar_url: z.string().nullable().optional(),
    }),
  )
    .optional()
    .catch(undefined),
});
