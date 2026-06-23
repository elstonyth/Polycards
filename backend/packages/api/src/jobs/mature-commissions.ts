import { MedusaContainer } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../modules/packs';
import { notifyFeed } from '../modules/packs/notify-feed';
import type PacksModuleService from '../modules/packs/service';

/**
 * Hourly commission maturity job (Phase 3b Task 7).
 *
 * Flips commission rows from `pending → available` once their maturity cooldown
 * has elapsed (matures_at <= now). This is cosmetic/audit only — the
 * availableBalance gate is read-time and already treats a pending row as
 * spendable once matures_at passes. The flip keeps the stored status in sync and
 * triggers a feed notification per beneficiary.
 *
 * Notification data: { commission_id, frozen } — payload is primitives-only.
 * Frozen beneficiaries have availableBalance 0; copy is intentionally neutral
 * so the storefront can branch on the `frozen` flag.
 */
export default async function matureCommissionsJob(
  container: MedusaContainer,
) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  await packs.matureDueCommissions(
    async (beneficiaryId, commissionId, frozen) => {
      await notifyFeed(container, {
        receiverId: beneficiaryId,
        template: 'commission_matured',
        data: { commission_id: commissionId, frozen },
        // Idempotency key: one notification per commission per maturity flip.
        idempotencyKey: `${commissionId}:matured`,
      });
    },
  );
}

export const config = {
  name: 'mature-commissions',
  schedule: '0 * * * *', // hourly
};
