/**
 * release-old-reward-holds.ts
 *
 * One-shot, after the ADR 0012 deploy: reward and gift sales are cash now, so
 * release what the ones sold before it still hold for packs. Per customer it
 * lowers those buyback rows' external_funded_cents by min(what is still held,
 * the stamps) under the credit lock, and writes one 'release_reward_holds'
 * audit row — the guard that makes a re-run a no-op (see
 * PacksModuleService.releaseOldRewardHoldsForCustomer). No money row is
 * written; balances do not move, only what is withdrawable.
 *
 * RUN (from backend/packages/api, after the migrate job of the deploy):
 *   corepack yarn medusa exec ./src/scripts/release-old-reward-holds.ts         # dry run
 *   corepack yarn medusa exec ./src/scripts/release-old-reward-holds.ts apply   # write
 *
 * Prints customer ids and sen only, no personal data.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';

const TAG = '[release-old-reward-holds]';

export default async function releaseOldRewardHolds({
  container,
  args,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const apply = args?.[0] === 'apply';

  if (process.env.NODE_ENV === 'production') {
    const pg = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
    const { rows } = await pg.raw('SELECT current_database() AS db');
    const db = (rows as { db: string }[])[0]?.db;
    // The live DB is `polycards`; a stale `pokenic` copy sits on the same cluster.
    if (db !== 'polycards') {
      throw new Error(`${TAG} refusing to run against database '${db}'`);
    }
  }

  const customerIds = await packs.customersWithOldRewardHolds();
  let releasedSen = 0;
  let releasing = 0;
  let alreadyReleased = 0;
  for (const customerId of customerIds) {
    const r = await packs.releaseOldRewardHoldsForCustomer(customerId, {
      apply,
      actor: 'script:release-old-reward-holds',
    });
    if (r.alreadyReleased) {
      alreadyReleased += 1;
      continue;
    }
    if (r.releasedSen > 0) releasing += 1;
    releasedSen += r.releasedSen;
    logger.info(
      `${TAG} ${customerId} held ${r.remainingSen} sen, releases ${r.releasedSen} sen`,
    );
  }
  logger.info(
    `${TAG} ${apply ? 'APPLIED' : 'DRY RUN (pass "apply" to write)'}: ` +
      `${customerIds.length} customer(s) with old reward/gift stamps, ` +
      `${releasing} with a hold to release, ${alreadyReleased} already released; ` +
      `total ${releasedSen} sen (RM ${(releasedSen / 100).toFixed(2)}).`,
  );
}
