import type { MedusaContainer } from '@medusajs/framework/types';
import { runDueSchedules } from '../api/admin/assistant/schedule';

// The admin assistant's scheduled tasks (api/admin/assistant/schedule.ts):
// every minute, run what is due.
export default async function assistantSchedulesJob(
  container: MedusaContainer,
) {
  await runDueSchedules(container);
}

export const config = {
  name: 'assistant-schedules',
  schedule: '* * * * *',
};
