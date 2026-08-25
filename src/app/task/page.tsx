import type { Metadata } from 'next';
import { getTaskHub } from '@/lib/actions/tasks';
import { getAuthToken } from '@/lib/data/customer';
import { TaskHubClient } from './TaskHubClient';

export const metadata: Metadata = {
  title: 'Task',
  description: 'Weekly tasks, achievements and your VIP level on Polycards.',
};

// The Task hub (referral rebuild, spec 2026-08-24; restructured 2026-08-25):
// two tabs — Weekly Tasks and Achievements & VIP. Referral has its own page
// at /referral. Server component per the house split; the loader returns null
// when logged out and the client tabs render a sign-in prompt instead.
export default async function TaskPage() {
  const [taskHub, token] = await Promise.all([getTaskHub(), getAuthToken()]);
  return <TaskHubClient taskHub={taskHub} isLoggedIn={Boolean(token)} />;
}
