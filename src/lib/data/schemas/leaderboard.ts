import { z } from './zod';
import { droppableArray, finite } from './shared';

/** GET /store/leaderboard row — name + finite points/volume/pulls. */
export const LeaderboardEntrySchema = z.looseObject({
  name: z.string(),
  points: finite,
  volume: finite,
  pulls: finite,
  avatar_url: z.string().nullable().optional(),
  equipped_frame_level: finite.nullable().optional(),
});

/** GET /store/leaderboard — the board as data/leaderboard.ts reads it.
 *
 *  `droppableArray`, NOT `listOf`: one malformed row still drops on its own,
 *  but a non-array `entries` must FAIL the parse rather than read as empty.
 *  That is a malformed 200, and this loader lives inside `cached()` — coercing
 *  it to [] would memoise a blank board for the whole window instead of
 *  evicting. Same reason for PacksPageSchema, PackDetailPageSchema and
 *  RecentPullsPageSchema below; the pre-port code spelled it
 *  `if (!Array.isArray(x)) throw` in front of `parseList`. */
export const LeaderboardPageSchema = z.looseObject({
  entries: droppableArray(LeaderboardEntrySchema),
});

/** GET /store/leaderboard/me — the caller's OWN weekly pulled value, pull
 *  count, and the PII-safe seed that locates their row on the public board. */
export const OwnWeeklySchema = z.looseObject({
  volume: finite,
  pulls: finite.int(),
  seed: finite.int(),
});
