import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import { getCardStockByHandle } from '../modules/packs/card-stock';
import { notifyFeed } from '../modules/packs/notify-feed';
import type PacksModuleService from '../modules/packs/service';

/**
 * Hourly Weekly-Challenge settlement (spec 2026-07-29).
 *
 * Settles the most recently ENDED challenge week: pays the week's top-10 the
 * union of every community-pool-unlocked stage's rank rewards. Self-gating —
 * an already-settled week (any challenge_payout row) returns immediately, so
 * the hourly cadence is a retry net, not a re-pay risk. Cron cannot be driven
 * by the admin-configured cadence row (schedule is static at boot); the gate
 * is what honors the configured week boundary.
 *
 * Notifications fire AFTER each winner's transaction committed (they ride the
 * returned winners list), best-effort + idempotent per (week, customer).
 */
export default async function settleChallengeWeekJob(
  container: MedusaContainer,
) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const result = await packs.settleChallengeWeek({
    getStock: (handles) => getCardStockByHandle(container, handles),
  });
  if (!result.settled) return;

  for (const w of result.winners) {
    try {
      await notifyFeed(container, {
        receiverId: w.customerId,
        template: 'challenge_payout',
        data: {
          week_start: result.weekStartIso,
          rank: w.rank,
          credits: w.credits,
          card_count: w.cardHandles.length,
        },
        idempotencyKey: `challenge:${result.weekStartIso}:${w.customerId}`,
      });
    } catch (err) {
      try {
        container
          .resolve(ContainerRegistrationKeys.LOGGER)
          .warn(
            `[settle-challenge-week] notifyFeed failed for ${w.customerId} (week ${result.weekStartIso}) — settlement committed, notification dropped: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
      } catch {
        // logger unavailable in test containers — ignore
      }
    }
  }
}

export const config = {
  name: 'settle-challenge-week',
  schedule: '0 * * * *', // hourly; the week gate makes extra runs no-ops
};
