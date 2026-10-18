import type { MedusaContainer } from '@medusajs/framework/types';
import { tickSandbox } from '../api/utils/automation-sandbox-store';

export default async function automationSandboxJob(
  container: MedusaContainer,
): Promise<void> {
  await tickSandbox(container);
}

export const config = {
  name: 'automation-sandbox',
  schedule: '*/2 * * * * *',
};
