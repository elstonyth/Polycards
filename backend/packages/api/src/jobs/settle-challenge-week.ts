import { Modules } from '@medusajs/framework/utils';
import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import { getCardStockByHandle,
  findCardInventoryTarget } from '../modules/packs/card-stock';
import { notifyFeedNonfatal } from '../modules/packs/notify-feed';
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
    // Settlement must RESERVE, not just read. Bound here for the same reason as
    // getStock: the inventory module is only reachable through the container.
    // Returns false for an untracked product — nothing to count, and the pull
    // must not be earmarked or buyback would restore a phantom unit.
    decrementStock: async (handle, qty) => {
      const target = await findCardInventoryTarget(container, handle);
      if (!target) return false;
      await container
        .resolve(Modules.INVENTORY)
        .adjustInventory(target.inventoryItemId, target.locationId, -qty);
      return true;
    },
    onSettled: async (w, weekStartIso) => {
      // Spec §Granting: a stock-gated card is NOT substituted with credit —
      // it becomes a manual-fulfilment item. The payout row records it, but
      // this line is the only thing that puts it in front of an operator.
      if (w.skippedCardIds.length > 0) {
        warn(
          `[settle-challenge-week] out of stock, NOT granted (manual fulfilment queue): customer ${w.customerId} rank ${w.rank} week ${weekStartIso} card ids ${w.skippedCardIds.join(', ')}`,
        );
      }
      // Non-fatal — never fail a committed payout over a notification. The
      // wrapper logs a producer failure instead of swallowing it silently
      // (matches every other post-commit producer, plan 059/052).
      await notifyFeedNonfatal(container, 'settle-challenge-week', {
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
    },
  });

  // Promotion runs AFTER settlement, and that order is the whole design: the
  // week that just ended must be paid with the stages it actually ran on. Swap
  // these two and a scheduled edition that came due overnight would pay out
  // last week's winners on next week's prize table.
  //
  // Same hourly tick as settlement for the same reason — cron cannot read the
  // admin-configured cadence (schedule is static at boot), so the gate does the
  // honoring: `applied_at` makes extra runs no-ops.
  try {
    const { promoted, failed } = await packs.promoteDueChallengeSchedules();
    if (promoted > 0) {
      warn(
        `[settle-challenge-week] promoted ${promoted} scheduled challenge(s)`,
      );
    }
    if (failed > 0) {
      // Left unstamped on purpose — it retries next hour and stays visible in
      // the admin's Scheduled tab. Usually a prize card deleted since queueing.
      warn(
        `[settle-challenge-week] ${failed} scheduled challenge(s) FAILED to promote and will be retried — check their prize cards still exist`,
      );
    }
  } catch (e) {
    // Never let promotion take the settlement job down: the winners above are
    // already paid, and a thrown job hides that in the crash.
    warn(
      `[settle-challenge-week] schedule promotion failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

export const config = {
  name: 'settle-challenge-week',
  schedule: '0 * * * *', // hourly; the week gate makes extra runs no-ops
};
