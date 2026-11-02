import type { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

// Operator-only repair. Age, reveals and ledger rows cannot prove workflow finality.
export default async function backfillCoinFlipEligibility({ container, args }: ExecArgs): Promise<void> {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  // `medusa exec` refuses unknown flags, so this is the positional word `apply`.
  const apply = args?.includes('apply') ?? false;
  const ingressDrained = process.env.COIN_FLIP_INGRESS_DRAINED === '1';
  if (apply && !ingressDrained) throw new Error('Stop pack ingress, drain/stop workers, resolve failed workflows, then set COIN_FLIP_INGRESS_DRAINED=1.');
  if ((await packs.coinFlipSettings()).enabled) throw new Error('Pause coin flip before maintenance.');
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    // A card in delivery comes back to the Vault if its order is cancelled.
    const rows = await packs.listPulls({ status: ['vaulted', 'delivering'], flip_eligible_at: null,
      ...(cursor ? { id: { $gt: cursor } } : {}) }, { take: 100, order: { id: 'ASC' } });
    if (!rows.length) break;
    if (apply) {
      const owners = new Map<string, string[]>();
      for (const row of rows) owners.set(row.customer_id, [...(owners.get(row.customer_id) ?? []), row.id]);
      for (const [customerId, pullIds] of owners) await packs.finalizeLegacyPullsForCoinFlip({ customerId, pullIds, ingressDrained });
    }
    count += rows.length;
    cursor = rows[rows.length - 1].id;
  }
  logger.info(`[coin-flip-eligibility] ${apply ? 'Marked' : 'Dry run: found'} ${count} unfinished/legacy vaulted or in-delivery cards. ${apply ? '' : 'Nothing changed.'}`);
}
