import { createStep, StepResponse } from '@medusajs/framework/workflows-sdk';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../modules/packs';
import type PacksModuleService from '../../modules/packs/service';
import { notifyFeed } from '../../modules/packs/notify-feed';

export type SettleVipInput = {
  customer_id: string;
  open_id: string; // the charge row's open id (source_open_id on grant rows)
};

// settle-vip — grant ladder rewards for every rung this open crossed, IN the
// open saga (sim day-3 vip-integrity HIGH). Previously VIP settled only via
// the post-commit vip.spend_settled event; event delivery is at-most-once, so
// a lost event permanently stranded every crossed rung and left GET /store/vip
// self-contradictory (next.remaining=0, level never advances) until the
// customer's NEXT open. Settling here makes the grant deterministic: it runs
// after the charge step's transaction committed, and grantLevelUpRewards
// recomputes from the ledger (idempotent, monotonic, multi-rung), so the
// event + subscriber stay as a harmless redelivery healer (a redelivered
// settle gains [] and sends no duplicate notification).
//
// BEST-EFFORT by design: a paid open must never be voided because a REWARD
// grant hiccuped — errors are caught and logged, and the vip.spend_settled
// event (emitted after this step) remains the retry path. No compensation:
// grants are monotonic on the lifetime counter (spec §3) and are not revoked
// by clawback, so there is nothing correct to undo.
export const settleVipStep = createStep(
  'settle-vip',
  async (input: SettleVipInput, { container }) => {
    try {
      const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
      const { gained } = await packs.grantLevelUpRewards(
        input.customer_id,
        input.open_id,
      );

      if (gained.length > 0) {
        // Same consolidated notification (and idempotency key) the
        // vip-spend-settled subscriber sends, so whichever path settles first
        // notifies exactly once.
        await notifyFeed(container, {
          receiverId: input.customer_id,
          template: 'vip_level_up',
          data: { levels: gained },
          idempotencyKey: `${input.open_id}:levelup`,
        });
      }
    } catch (error) {
      // Best-effort log: resolve AND emit inside one guard, so a container
      // without a real logger cannot throw out of this deliberately
      // non-fatal step (see the BEST-EFFORT note above).
      try {
        container
          .resolve(ContainerRegistrationKeys.LOGGER)
          .warn(
            `settle-vip: level-up grant or notifyFeed('vip_level_up') failed for receiver '${input.customer_id}' (open '${input.open_id}') — open continues, vip.spend_settled event is the retry path. ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
      } catch {
        // logger not available in test container — silently ignore
      }
    }
    return new StepResponse(undefined);
  },
);

export default settleVipStep;
