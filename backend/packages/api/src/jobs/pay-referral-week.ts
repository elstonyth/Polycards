import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

/**
 * The pay half of "WED OUT" — pays every APPROVED weekly settlement's
 * pending lines as straight site credit. A run the admin never approved
 * simply waits: the human gate IS the spec, so this job never touches
 * drafts. Runs hourly every day (not just Wednesdays — review 2026-08-25):
 * an approval that lands on a Thursday pays within the hour instead of
 * silently waiting six days, and pay is idempotent per line either way.
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
  schedule: '0 * * * *', // hourly, every day; pay is idempotent per line
};
