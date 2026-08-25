import type { Metadata } from 'next';
import { getReferralSummary } from '@/lib/data/referral';
import { getAuthToken } from '@/lib/data/customer';
import { ReferralClient } from './ReferralClient';

export const metadata: Metadata = {
  title: 'Referral',
  description:
    'Invite friends to Polycards and earn a weekly cut of everything they rip.',
};

// Split out of the /task hub 2026-08-25 — referral is its own surface now,
// reached from the Me quick-access grid. Deliberately NOT under (account):
// a logged-out visitor should see the sign-in prompt (and the pitch) rather
// than be bounced to the auth modal.
export default async function ReferralPage() {
  const [referral, token] = await Promise.all([
    getReferralSummary(),
    getAuthToken(),
  ]);
  return <ReferralClient data={referral} isLoggedIn={Boolean(token)} />;
}
