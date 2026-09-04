import type { Metadata } from 'next';
import LeaderboardClient from './LeaderboardClient';
import { WeeklyChallenge, ChallengeRules } from './WeeklyChallenge';
import { getLeaderboard, getOwnWeekly } from '@/lib/data/leaderboard';
import { getChallenge } from '@/lib/data/challenge';
import { getOwnProfileHandle } from '@/lib/data/profiles';
import { getAvatarFrames } from '@/lib/data/avatar-frames';

// Live leaderboard + Weekly Pulled Value Challenge, aggregated from the gacha
// Pull ledger. Fetched server-side (the storefront origin can reach the backend;
// the browser is CORS-blocked) and rendered per-request; standings and avatar
// frames are memoised (30s/60s per instance, see src/lib/ttl-cache.ts) — the
// challenge block is genuinely per-request.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Ranks',
  description:
    'Live standings and the Weekly Pulled Value Challenge on Polycards.',
};

export default async function LeaderboardPage() {
  // All fetches run concurrently — getLeaderboard awaits the catalog promise
  // internally, only for post-fetch frame enrichment.
  const framesPromise = getAvatarFrames();
  const [ownHandle, ownWeekly, challenge, weekly, alltime] = await Promise.all([
    // null when logged out — the client hides the "your rank" card then.
    getOwnProfileHandle().catch(() => null),
    // The caller's own weekly pulled value — the only way to say how far a
    // player BELOW the top-10 slice is from reaching it. Authenticated and
    // uncached, so it can never be a field on the public board. null when
    // logged out or the hop fails; the card then reads as it does today.
    getOwnWeekly().catch(() => null),
    // null when the challenge is off or the backend hop fails — the standings
    // must still render.
    getChallenge().catch(() => null),
    getLeaderboard('weekly', framesPromise),
    getLeaderboard('alltime', framesPromise),
  ]);

  return (
    <>
      {/* The page owns the h1 — the tab is "Ranks", and the page is both the
          challenge and the standings, neither of which can claim the other's
          heading. Visually the challenge hero (or LEADERBOARD when the
          challenge is off) already titles the page. */}
      <h1 className="sr-only">Ranks</h1>
      {challenge && <WeeklyChallenge challenge={challenge} />}
      <LeaderboardClient
        weekly={weekly}
        alltime={alltime}
        ownHandle={ownHandle}
        ownWeekly={ownWeekly}
        weeklyPrizes={challenge?.rankPrizes ?? []}
      />
      {challenge && <ChallengeRules />}
      {/* Clearance so the fixed your-rank card never covers the last block. */}
      {ownHandle != null && <div aria-hidden className="h-24" />}
    </>
  );
}
