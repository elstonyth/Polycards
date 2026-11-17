// The JSON body of GET /store/leaderboard, written once (ADR 0018). Types
// only. No imports: the storefront typecheck reads this file (as
// `@acme/api/store/leaderboard`) without the backend's node_modules.

/** A ranked row: numbers and PII-safe display fields only. */
export type StoreLeaderboardEntry = {
  /** 1..N over the shown players, no gaps. */
  rank: number;
  name: string;
  /** null for a customer that predates handle assignment. */
  handle: string | null;
  volume: number;
  pulls: number;
  points: number;
  seed: number;
  avatar_url: string | null;
  equipped_frame_level: number | null;
};

export type StoreLeaderboardResponse = {
  period: 'alltime' | 'weekly';
  entries: StoreLeaderboardEntry[];
};
