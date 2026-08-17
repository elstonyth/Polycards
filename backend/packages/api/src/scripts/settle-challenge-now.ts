/**
 * settle-challenge-now.ts
 *
 * One-shot Weekly-Challenge settlement — the exact call the hourly
 * settle-challenge-week job makes, run on demand. This is the operator's
 * manual-settlement tool for the accepted multi-week-outage limitation: the
 * job (and this script) settle only the MOST RECENTLY ENDED week, so a week
 * missed because the backend was down across a whole reset must be settled by
 * hand from the challenge_payout audit trail. Stock never blocks a grant; a
 * `skipped_no_stock` row now only means the prize Card row is gone (run
 * grant-skipped-challenge-cards.ts for rows written under the old gate).
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
import { takeCardStock } from '../modules/packs/card-stock';

export default async function settleChallengeNow({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const result = await packs.settleChallengeWeek({
    decrementStock: takeCardStock(container),
  });

  logger.info(`[settle-challenge-now] ${JSON.stringify(result, null, 2)}`);
}
