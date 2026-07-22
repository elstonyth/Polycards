/**
 * rebuild-vip-turnover.ts
 *
 * One-shot reconciliation after the 2026-07-22 turnover-VIP change (VIP basis
 * = ALL pack_open spend, winnings included — commissions and the withdrawal
 * playthrough gate still use the external-funded basis). Re-runs the ladder
 * grant for every customer who has ever touched the credit ledger so levels
 * and rewards catch up to the new basis.
 *
 * RUN (from backend/packages/api):
 *   corepack yarn medusa exec ./src/scripts/rebuild-vip-turnover.ts
 *
 * Idempotent: grants are ON CONFLICT DO NOTHING and the state upsert converges.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';

export default async function rebuildVipTurnover({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const customers = await packs.listLedgerCustomerIds();
  for (const customerId of customers) {
    const { gained } = await packs.grantLevelUpRewards(
      customerId,
      'turnover-backfill',
    );
    if (gained.length > 0) {
      logger.info(
        `[rebuild-vip-turnover] ${customerId} gained level(s) ${gained.join(', ')}`,
      );
    }
  }
  logger.info(
    `[rebuild-vip-turnover] ${customers.length} customer(s) reconciled. Done.`,
  );
}
