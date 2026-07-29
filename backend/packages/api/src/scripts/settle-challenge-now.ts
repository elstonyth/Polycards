/**
 * settle-challenge-now.ts
 *
 * One-shot Weekly-Challenge settlement — the exact call the hourly
 * settle-challenge-week job makes, run on demand. This is the operator's
 * manual-settlement tool for the accepted multi-week-outage limitation: the
 * job (and this script) settle only the MOST RECENTLY ENDED week, so a week
 * missed because the backend was down across a whole reset must be settled by
 * hand from the challenge_payout audit trail — and any `skipped_no_stock`
 * rows are the operator's manual-fulfillment queue.
 *
 * RUN (DB reachable):
 *   corepack yarn medusa exec ./src/scripts/settle-challenge-now.ts
 *
 * Idempotent: an already-settled week prints { settled: false } — safe to
 * re-run any time. Feed notifications are the JOB's concern, not this
 * script's — a manual settlement stays silent.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';
import { getCardStockByHandle } from '../modules/packs/card-stock';

export default async function settleChallengeNow({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const result = await packs.settleChallengeWeek({
    getStock: (handles) => getCardStockByHandle(container, handles),
  });

  logger.info(
    `[settle-challenge-now] ${JSON.stringify(result, null, 2)}`,
  );
}
