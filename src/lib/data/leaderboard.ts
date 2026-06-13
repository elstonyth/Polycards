/**
 * Leaderboard data seam.
 *
 * Reads the live leaderboard from the custom Medusa route
 * `GET /store/leaderboard?period=` (aggregated from the gacha Pull ledger), and
 * maps it to the presentational shape the table/podium render. Degrades to the
 * static mock board (real phygitals data) when the backend is unreachable or the
 * ledger is empty, so the page stays populated + pixel-perfect.
 *
 * The backend is PII-safe (display name + avatar seed only — never email/id), so
 * nothing sensitive crosses into the storefront.
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { avatarForSeed } from '@/lib/profile-view';

export type LeaderboardPeriod = 'weekly' | 'alltime';

export interface LeaderboardEntry {
  rank: number;
  name: string;
  /**
   * Public profile handle for /profile/<handle> links. Absent/null for the
   * static mock board and for collectors that predate handle assignment —
   * the row then keeps the legacy name link (mock-pool fallback).
   */
  handle?: string | null;
  /** Formatted USD winnings, e.g. "US$8,173,374.26". */
  volume: string;
  pulls: string;
  points: string;
  avatar: string;
}

// One row from GET /store/leaderboard (numbers + an avatar seed, no PII).
interface BackendEntry {
  rank: number;
  name: string;
  handle: string | null;
  volume: number;
  pulls: number;
  points: number;
  seed: number;
}

// Avatar mapping is shared with the profile page (lib/profile-view.ts) so the
// same PII-safe seed renders the same avatar on both surfaces.

const fmtUsd = (n: number): string =>
  `US$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Static fallback — real data + avatars extracted verbatim from phygitals.com's
// homepage "Weekly Leaderboard". Keeps the page populated and on-brand when the
// backend is down or the ledger is empty.
export const MOCK_LEADERBOARD: LeaderboardEntry[] = [
  {
    rank: 1,
    name: 'FightingProdigy3098',
    volume: 'US$8,173,374.26',
    pulls: '1403',
    points: '812,296,655',
    avatar: '/images/pfps/pfp-30.webp',
  },
  {
    rank: 2,
    name: 'love',
    volume: 'US$4,293,513.36',
    pulls: '232',
    points: '428,287,429',
    avatar: '/images/pfps/pfp-81.webp',
  },
  {
    rank: 3,
    name: 'PsychicGuardian5685',
    volume: 'US$1,399,630.64',
    pulls: '723',
    points: '139,937,985',
    avatar: '/images/pfps/pfp-71.webp',
  },
  {
    rank: 4,
    name: 'HyperResearcher7463',
    volume: 'US$1,189,685.65',
    pulls: '360',
    points: '118,968,718',
    avatar: '/images/pfps/pfp-58.webp',
  },
  {
    rank: 5,
    name: 'PrinceOfDragons',
    volume: 'US$469,126.15',
    pulls: '827',
    points: '46,912,908',
    avatar: '/images/pfps/pfp-31.webp',
  },
  {
    rank: 6,
    name: 'AncientMaster2024',
    volume: 'US$392,343.09',
    pulls: '41',
    points: '39,234,328',
    avatar: '/images/pfps/pfp-60.webp',
  },
  {
    rank: 7,
    name: 'RapidDefender3371',
    volume: 'US$358,774.38',
    pulls: '120',
    points: '35,737,514',
    avatar: '/images/pfps/pfp-1.webp',
  },
  {
    rank: 8,
    name: 'EnergyProdigy7233',
    volume: 'US$298,032.28',
    pulls: '33',
    points: '29,803,240',
    avatar: '/images/pfps/pfp-76.webp',
  },
  {
    rank: 9,
    name: 'RockHunter9181',
    volume: 'US$230,400',
    pulls: '12',
    points: '23,040,000',
    avatar: '/images/pfps/pfp-66.webp',
  },
  {
    rank: 10,
    name: 'AquaCatcher6841',
    volume: 'US$214,782.06',
    pulls: '82',
    points: '21,478,238',
    avatar: '/images/pfps/pfp-28.webp',
  },
];

/**
 * Live leaderboard for a period. Maps the backend aggregate to the table shape,
 * assigning a deterministic avatar from the PII-safe seed. Falls back to the
 * static mock board on any backend failure or empty ledger.
 */
export async function getLeaderboard(
  period: LeaderboardPeriod = 'weekly',
): Promise<LeaderboardEntry[]> {
  try {
    const { entries } = await sdk.client.fetch<{ entries: BackendEntry[] }>(
      `/store/leaderboard?period=${period}`,
    );
    if (!Array.isArray(entries) || entries.length === 0)
      return MOCK_LEADERBOARD;

    const mapped = entries
      .filter(
        (e) =>
          e &&
          typeof e.name === 'string' &&
          Number.isFinite(e.points) &&
          Number.isFinite(e.volume) &&
          Number.isFinite(e.pulls),
      )
      .map((e, i) => ({
        rank: i + 1,
        name: e.name,
        handle: typeof e.handle === 'string' ? e.handle : null,
        volume: fmtUsd(e.volume),
        pulls: String(e.pulls),
        points: Math.round(e.points).toLocaleString('en-US'),
        avatar: avatarForSeed(e.seed),
      }));

    return mapped.length ? mapped : MOCK_LEADERBOARD;
  } catch (error) {
    logger.error(`[leaderboard] failed to load (${period}):`, error);
    return MOCK_LEADERBOARD;
  }
}
