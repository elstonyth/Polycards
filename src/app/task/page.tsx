import type { Metadata } from 'next';
import { getTaskHub } from '@/lib/actions/tasks';
import { getAuthToken, getCustomerSession } from '@/lib/data/customer';
import { TaskHubClient } from './TaskHubClient';

export const metadata: Metadata = {
  title: 'Task',
  description: 'Weekly tasks, achievements and your VIP level on Polycards.',
};

// The Task hub (referral rebuild, spec 2026-08-24; restructured 2026-08-25):
// two tabs — Weekly Tasks and Achievements. Referral has its own page
// at /referral. Server component per the house split; the loader returns null
// when logged out and the client tabs render a sign-in prompt instead.
//
// isLoggedIn comes from the customer read, not cookie presence: an expired
// JWT (1d) still sits in the cookie, and "token but no data" rendered the
// "couldn't load — refresh" panel forever instead of the sign-in prompt.
// A token the backend did NOT reject (5xx / network) still counts as logged
// in, so a backend blip shows the unavailable panel, not the sign-in pitch.
export default async function TaskPage() {
  const [taskHub, { customer, stale }, token] = await Promise.all([
    getTaskHub(),
    getCustomerSession(),
    getAuthToken(),
  ]);
  const isLoggedIn = customer !== null || (Boolean(token) && !stale);
  return <TaskHubClient taskHub={taskHub} isLoggedIn={isLoggedIn} />;
}
