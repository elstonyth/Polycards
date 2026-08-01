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
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { avatarForSeed } from '@/lib/profile-view';
import { rm } from '@/lib/format';
import { parseList, LeaderboardEntrySchema } from '@/lib/data/schemas';

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
  pulls: string;
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
 * Live leaderboard for a period. Maps the backend aggregate to the standings
 * shape, assigning a deterministic avatar from the PII-safe seed. Returns []
 * on any backend failure or an empty ledger — never fake rows.
 */
export async function getLeaderboard(
  period: LeaderboardPeriod = 'weekly',
  // Accepts the pending catalog promise so callers can start this fetch and
  // getAvatarFrames() concurrently — frames are only needed for enrichment
  // after the entries arrive, never to start the request.
  framesInput: Record<string, string> | Promise<Record<string, string>> = {},
): Promise<LeaderboardEntry[]> {
  try {
    const { entries } = await sdk.client.fetch<{ entries: BackendEntry[] }>(
      `/store/leaderboard?period=${period}`,
    );
    if (!Array.isArray(entries) || entries.length === 0) return [];
    const frames = await framesInput;

    return (
      parseList(LeaderboardEntrySchema, entries) as unknown as BackendEntry[]
    ).map((e, i) => ({
      rank: i + 1,
      name: e.name,
      handle: typeof e.handle === 'string' ? e.handle : null,
      volume: rm(e.volume),
      pulls: String(e.pulls),
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
