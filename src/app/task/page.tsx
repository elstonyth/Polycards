import type { Metadata } from 'next';
import { getReferralSummary, getVipRebate } from '@/lib/data/referral';
import { TaskHubClient } from './TaskHubClient';

export const metadata: Metadata = {
  title: 'Task',
  description:
    'Weekly tasks, your referral earnings and your VIP rebate on Polycards.',
};

// The Task hub (referral rebuild, spec 2026-08-24): Tasks (Phase B fills the
// list), Referral (invite link + weekly commission), VIP (weekly 回水 rebate).
// Server component per the house split — both loaders return null when logged
// out, and the client tabs render a sign-in prompt instead.
export default async function TaskPage() {
  const [referral, vipRebate] = await Promise.all([
    getReferralSummary(),
    getVipRebate(),
  ]);
  return <TaskHubClient referral={referral} vipRebate={vipRebate} />;
}
