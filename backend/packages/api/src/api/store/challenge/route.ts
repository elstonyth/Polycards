import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { buildChallengeView } from './build';

// GET /store/challenge — public read of the Weekly Pulled Value Challenge.
// Plain publishable-key store route, read-only, mirrors GET /store/leaderboard.
//
// Standard ("Weekly Pulled Value Challenge"): every eligible pack draw feeds
// BOTH the community pool and the personal Weekly Pull Value ranking; community
// milestones unlock CUMULATIVE reward stages, each carrying its own per-rank
// prize table (ranks 1-10, card and/or credits); the week's top-10 receive
// everything unlocked. There is NO
// separate flat payout — stages ARE the prize pool (the old settings payout
// fields are retired and not exposed here).
//
// The view itself is built in ./build.ts, shared with the Growth desk report
// (GET /reports/growth/challenge) so both always show the same board.
//
// 🔒 PII: public — names follow the leaderboard rules (first_name or an
// anonymous "Collector ####", plus the stable avatar seed; never email/id).

// ponytail: per-process 30s cache — this route runs TWO whole-`pull`-table
// aggregates (community pool + top-N pull value) whose cost grows with pull
// history, on a public unauthenticated route. Same TTL as the sibling
// leaderboard board (so /task and the weekly board converge within one
// window). No query params → one entry.
// >1 instance since #473: per-process is accepted — N instances = N
// computes per window and ≤TTL cross-instance skew, display-only either
// way. Decision + upgrade path recorded in plan 116.
const CACHE_TTL_MS = 30_000;
let challengeCache: { expires: number; body: unknown } | null = null;

/** Test seam: module state outlives a test's fixtures — the http suite runs in
 *  one process, so test A's cached challenge would be served to test B. */
export function clearChallengeCache(): void {
  challengeCache = null;
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (challengeCache && challengeCache.expires > Date.now()) {
    res.json(challengeCache.body);
    return;
  }

  const { body } = await buildChallengeView(req.scope);
  challengeCache = { expires: Date.now() + CACHE_TTL_MS, body };
  res.json(body);
}
