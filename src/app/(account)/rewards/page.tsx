import type { Metadata } from 'next';
import { getRewards } from '@/lib/actions/rewards';
import RewardsClient from './RewardsClient';

export const metadata: Metadata = { title: 'My Rewards' };

export default async function RewardsPage() {
  const res = await getRewards();
  return <RewardsClient initial={res} />;
}
