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
 *
 * Each run is ISOLATED. Without the try/catch a single settlement that throws
 * — a DB blip, or one poisoned row — aborts the loop, so every OTHER approved
 * week goes unpaid that hour. A permanently-failing run would block all
 * payouts forever, which is a far worse failure than one week being late.
 */
export default async function payReferralWeekJob(container: MedusaContainer) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const say = (level: 'info' | 'error', message: string) => {
    try {
      container.resolve(ContainerRegistrationKeys.LOGGER)[level](message);
    } catch {
      // logger unavailable in test containers — ignore
    }
  };

  const approved = await packs.listWeeklySettlements(
    { status: 'approved' },
    { take: 100 },
  );
  let failed = 0;
  for (const run of approved) {
    try {
      const result = await packs.payWeeklySettlement({ settlementId: run.id });
      say(
        'info',
        `[pay-referral-week] settlement ${run.id}: paid ${result.paid}, skipped ${result.skipped}`,
      );
    } catch (e: unknown) {
      // Pay is idempotent per line, so the next hourly tick retries this run
      // from wherever it stopped. Logged loudly because a run that keeps
      // failing is money nobody is receiving.
      failed++;
      say(
        'error',
        `[pay-referral-week] settlement ${run.id} FAILED, will retry next tick: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }
  if (failed > 0) {
    say(
      'error',
      `[pay-referral-week] ${failed} of ${approved.length} approved run(s) failed this tick.`,
    );
  }
}

export const config = {
  name: 'pay-referral-week',
  schedule: '0 * * * *', // hourly, every day; pay is idempotent per line
};
