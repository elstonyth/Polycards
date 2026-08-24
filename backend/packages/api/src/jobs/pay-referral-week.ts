import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

/**
 * Wednesday pay ("WED OUT") — pays every APPROVED weekly settlement's pending
 * lines as straight site credit. A run the admin never approved simply waits:
 * the human gate IS the spec, so this job never touches drafts.
 *
 * Idempotent end to end (line status + the RF ledger (type, ref_id) unique
 * index), so the hourly Wednesday cadence — and an admin's early "Pay now"
 * from the dashboard — can never double-credit anyone. Deleted-account
 * voiding and the pay_settlement audit both live inside payWeeklySettlement.
 */
export default async function payReferralWeekJob(container: MedusaContainer) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const log = (message: string) => {
    try {
      container.resolve(ContainerRegistrationKeys.LOGGER).info(message);
    } catch {
      // logger unavailable in test containers — ignore
    }
  };

  const approved = await packs.listWeeklySettlements(
    { status: 'approved' },
    { take: 100 },
  );
  for (const run of approved) {
    const result = await packs.payWeeklySettlement({ settlementId: run.id });
    log(
      `[pay-referral-week] settlement ${run.id}: paid ${result.paid}, skipped ${result.skipped}`,
    );
  }
}

export const config = {
  name: 'pay-referral-week',
  schedule: '0 * * * 3', // hourly on Wednesdays; pay is idempotent per line
};
