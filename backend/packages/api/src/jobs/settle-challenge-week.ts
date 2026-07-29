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
 * The onSettled callback runs per winner, AFTER that winner's transaction
 * committed: notification (best-effort + idempotent per (week, customer)) and
 * the spec's stock-gate warning. Per winner rather than after the batch so a
 * crash later in the batch cannot permanently drop an already-paid winner's
 * notification — the next tick's gate skips them, so it would never retry.
 */
export default async function settleChallengeWeekJob(
  container: MedusaContainer,
) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const warn = (message: string) => {
    try {
      container.resolve(ContainerRegistrationKeys.LOGGER).warn(message);
    } catch {
      // logger unavailable in test containers — ignore
    }
  };

  await packs.settleChallengeWeek({
    getStock: (handles) => getCardStockByHandle(container, handles),
    onSettled: async (w, weekStartIso) => {
      // Spec §Granting: a stock-gated card is NOT substituted with credit —
      // it becomes a manual-fulfilment item. The payout row records it, but
      // this line is the only thing that puts it in front of an operator.
      if (w.skippedCardIds.length > 0) {
        warn(
          `[settle-challenge-week] out of stock, NOT granted (manual fulfilment queue): customer ${w.customerId} rank ${w.rank} week ${weekStartIso} card ids ${w.skippedCardIds.join(', ')}`,
        );
      }
      try {
        await notifyFeed(container, {
          receiverId: w.customerId,
          template: 'challenge_payout',
          data: {
            week_start: weekStartIso,
            rank: w.rank,
            credits: w.credits,
            // Pulls MINTED, not distinct handles — two unlocked stages can
            // award the same card to one rank.
            card_count: w.cardCount,
          },
          idempotencyKey: `challenge:${weekStartIso}:${w.customerId}`,
        });
      } catch (err) {
        warn(
          `[settle-challenge-week] notifyFeed failed for ${w.customerId} (week ${weekStartIso}) — settlement committed, notification dropped: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
  });
}

export const config = {
  name: 'settle-challenge-week',
  schedule: '0 * * * *', // hourly; the week gate makes extra runs no-ops
};
