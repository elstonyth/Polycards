/**
 * Leaderboard data seam.
 *
 * Reads the live leaderboard from the custom Medusa route
 * `GET /store/leaderboard?period=` — weekly ranks by pulled value over the
 * challenge-anchored week (the Weekly Pull Value board the challenge settles on);
 * alltime ranks by REAL pack-open spend — and maps it to the
 * presentational shape the standings render. Returns [] when the backend is unreachable or
 * the board is empty — the page shows an honest empty state instead of fake
 * rows (the old mock board actively misled operators).
 *
 * The backend is PII-safe (display name + avatar seed only — never email/id),
 * so nothing sensitive crosses into the storefront.
 */
import { store } from '@/lib/store';
import { logger } from '@/lib/logger';
import { avatarForSeed } from '@/lib/profile-view';
import { rm } from '@/lib/format';
import { LeaderboardPageSchema, OwnWeeklySchema } from '@/lib/data/schemas';
import { cached } from '@/lib/ttl-cache';

export type LeaderboardPeriod = 'weekly' | 'alltime';

export interface LeaderboardEntry {
  rank: number;
  name: string;
  /**
   * Public profile handle for /profile/<handle> links. Null for collectors
   * that predate handle assignment — the row then renders unlinked.
   */
  handle?: string | null;
  /** Formatted MYR winnings, e.g. "RM 8,173.26". */
  volume: string;
  /** The same figure UNFORMATTED, because a rank gap is subtraction and
   *  "RM 8,173.26" is not a number. Weekly only is meaningful: All Time ranks
   *  by spend while displaying pulled value, so deltas between All Time rows
   *  can come out negative. See leaderboard-gap.ts. */
  volumeMyr: number;
  pulls: string;
  /** PII-safe avatar seed, also the stable key for "is this row me?". Unlike
   *  `handle`, which is assigned lazily on a player's first render, it exists
   *  from the moment the customer does. See leaderboard-gap.ts#findOwnRow. */
  seed: number;
  avatar: string;
  frame: string | null;
}

// One row from GET /store/leaderboard (numbers + an avatar seed, no PII).
interface BackendEntry {
  rank: number;
  name: string;
  handle: string | null;
  volume: number;
  pulls: number;
  seed: number;
  avatar_url?: string | null;
  equipped_frame_level?: number | null;
}

// Avatar mapping is shared with the profile page (lib/profile-view.ts) so the
// same PII-safe seed renders the same avatar on both surfaces.

/**
 * Leaderboard for a period (rows memoised 30s per instance). Maps the backend
 * aggregate to the standings shape, assigning a deterministic avatar from the
 * PII-safe seed. Returns [] on any backend failure or an empty ledger — never
 * fake rows.
 */
// Matches the backend's own 30s window on GET /store/leaderboard. Only the raw
// rows are memoised — the frame enrichment below depends on the caller's avatar
// catalog promise, which is not a cache key. The board renders on the home page
// AND /leaderboard, both of which read auth cookies elsewhere in the tree and so
// can never be statically rendered; without this each request re-pays the
// backend hop and the zod parse for an already-cached body.
const BOARD_TTL_MS = 30_000;

/** Parsed board rows for a period, memoised per process for one window. */
function fetchBoard(period: LeaderboardPeriod): Promise<BackendEntry[]> {
  return cached(`leaderboard:${period}`, BOARD_TTL_MS, async () => {
    // `period` rides the port's query option rather than the path, which is
    // the same `?period=weekly` on the wire. Public route: no bearer, and no
    // cache key (`cache: 'auto'`) — the bare sdk.client.fetch sent neither.
    //
    // orThrow, and LeaderboardPageSchema rejects a non-array `entries`: that
    // is a malformed 200, and it must reject so the TTL memo evicts instead
    // of caching a blanked board for the window. Empty-and-valid is a real,
    // cacheable state (a quiet leaderboard), and a single bad ROW still drops
    // on its own.
    const { entries } = store.orThrow(
      await store.get('/store/leaderboard', LeaderboardPageSchema, {
        auth: 'none',
        cache: 'auto',
        query: { period },
      }),
    );
    return entries as unknown as BackendEntry[];
  });
}

export async function getLeaderboard(
  period: LeaderboardPeriod = 'weekly',
  // Accepts the pending catalog promise so callers can start this fetch and
  // getAvatarFrames() concurrently — frames are only needed for enrichment
  // after the entries arrive, never to start the request.
  framesInput: Record<string, string> | Promise<Record<string, string>> = {},
): Promise<LeaderboardEntry[]> {
  try {
    const entries = await fetchBoard(period);
    if (entries.length === 0) return [];
    const frames = await framesInput;

    return entries.map((e, i) => ({
      rank: i + 1,
      name: e.name,
      handle: typeof e.handle === 'string' ? e.handle : null,
      volume: rm(e.volume),
      volumeMyr: e.volume,
      pulls: String(e.pulls),
      seed: e.seed,
      avatar: e.avatar_url ?? avatarForSeed(e.seed),
      frame: e.equipped_frame_level
        ? (frames[String(e.equipped_frame_level)] ?? null)
        : null,
    }));
  } catch (error) {
    logger.error(`[leaderboard] failed to load (${period}):`, error);
    return [];
  }
}

/** The caller's own weekly pulled value + pull count, or null when logged out
 *  or the backend hop fails. */
export interface OwnWeekly {
  volumeMyr: number;
  pulls: number;
  /** The caller's PII-safe seed — the key that finds their row on the public
   *  board (see leaderboard-gap.ts#findOwnRow). */
  seed: number;
}

/**
 * The caller's OWN standing in the current challenge week — the figure the
 * weekly board ranks by, for the player whose row the top-10 slice cut off.
 *
 * Deliberately NOT cached, and deliberately not a field on getLeaderboard():
 * that board memoises per period under a shared process-wide key, so a
 * per-customer number folded into it would be served to the next visitor for
 * the rest of the window.
 *
 * Never throws — the standings must render for a logged-in player even if this
 * hop fails; the card then falls back to the copy it shows today.
 */
export async function getOwnWeekly(): Promise<OwnWeekly | null> {
  // Every failure is the same answer here — logged out, a rejected token, a
  // backend blip, a malformed 200 — so the port's Result collapses the old
  // token guard, `parseOne` null check and `catch` into one branch.
  const r = await store.get('/store/leaderboard/me', OwnWeeklySchema);
  if (!r.ok) return null;
  return { volumeMyr: r.data.volume, pulls: r.data.pulls, seed: r.data.seed };
}
