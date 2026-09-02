import type { Metadata } from 'next';
import { getReferralSummary } from '@/lib/data/referral';
import { getAuthToken, getCustomerSession } from '@/lib/data/customer';
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
//
// isLoggedIn comes from the customer read, not cookie presence — same reason
// as /task: an expired JWT in the cookie must fall through to the sign-in
// prompt, not the "couldn't load" panel; a token the backend did NOT reject
// (5xx / network) still counts as logged in.
export default async function ReferralPage() {
  const [referral, { customer, stale }, token] = await Promise.all([
    getReferralSummary(),
    getCustomerSession(),
    getAuthToken(),
  ]);
  const isLoggedIn = customer !== null || (Boolean(token) && !stale);
  return <ReferralClient data={referral} isLoggedIn={isLoggedIn} />;
}
