import type { Metadata } from 'next';
import LeaderboardClient from './LeaderboardClient';
import { getLeaderboard } from '@/lib/data/leaderboard';

// Live leaderboard, aggregated from the gacha Pull ledger. Fetched server-side
// (the storefront origin can reach the backend; the browser is CORS-blocked) and
// rendered per-request so it always reflects the current ledger.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Leaderboard',
};

export default async function LeaderboardPage() {
  const [weekly, alltime] = await Promise.all([
    getLeaderboard('weekly'),
    getLeaderboard('alltime'),
  ]);

  return <LeaderboardClient weekly={weekly} alltime={alltime} />;
}
