import { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

// visitor_signal keeps 180 days, as the privacy page says (ADR 0016).
export default async function purgeVisitorSignals(
  container: MedusaContainer,
): Promise<void> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  await packs.purgeVisitorSignals();
}

export const config = {
  name: 'purge-visitor-signals',
  schedule: '30 19 * * *', // 03:30 MYT
};
