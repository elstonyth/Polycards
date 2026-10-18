import type { MedusaContainer } from '@medusajs/framework/types';
import { tickLive } from '../api/utils/automation-live-store';

export default async function automationLiveJob(
  container: MedusaContainer,
): Promise<void> {
  await tickLive(container);
}

export const config = { name: 'automation-live', schedule: '*/2 * * * * *' };
