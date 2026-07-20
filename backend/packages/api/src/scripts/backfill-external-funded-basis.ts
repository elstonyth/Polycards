/**
 * backfill-external-funded-basis.ts
 *
 * One-shot backfill for pre-1b grandfathered deposits (topups written before
 * Migration20260621120000, external_funded_cents IS NULL). Those deposits never
 * entered the external-funded balance, so every pack open they funded stamped
 * a 0 VIP basis and the customer's VIP level never moved despite real spend.
 *
 * For each affected customer this stamps the NULL topups at face value,
 * replays consumption over their chronological ledger with the live arithmetic
 * (recomputeExternalStamps), and re-runs grantLevelUpRewards so crossed rungs
 * settle (state row + ladder voucher/box/frame grants).
 *
 * SIDE EFFECT (accepted): stamped topups join the deposited-playthrough basis,
 * so affected customers' withdrawable gates tighten to "deposits fully played
 * through" (plans 033/038).
 *
 * RUN (from backend/packages/api):
 *   corepack yarn medusa exec ./src/scripts/backfill-external-funded-basis.ts
 *
 * Idempotent: a second run finds no NULL-basis topups and changes nothing.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';

export default async function backfillExternalFundedBasis({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const { customers, rowsUpdated, leveled } =
    await packs.backfillExternalFundedBasis();

  for (const [customerId, gained] of Object.entries(leveled)) {
    logger.info(
      `[backfill-external-funded-basis] ${customerId} gained level(s) ${gained.join(', ')}`,
    );
  }
  logger.info(
    `[backfill-external-funded-basis] ${customers} customer(s), ${rowsUpdated} ledger row(s) restamped. Done.`,
  );
}
