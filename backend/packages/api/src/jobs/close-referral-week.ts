import { MedusaContainer } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../modules/packs';
import type PacksModuleService from '../modules/packs/service';

/**
 * Tuesday close ("TUES CHECK") — computes the just-ended referral week
 * (Tue 00:00 MYT → Tue 00:00 MYT) into a DRAFT weekly_settlement for the
 * admin to review. No money moves here; pay-referral-week.ts does that after
 * the approve gate.
 *
 * Hourly EVERY day, not just Tuesdays (review 2026-08-25 finding 1): the
 * unique week_start makes every run after the first a no-op, and
 * lastClosedReferralWeek(now) points at the same week for seven days — so a
 * backend that was down the whole of Tuesday (deploy window, migrate gate,
 * DB blip) still closes the week the moment it comes back, any day. A
 * Tuesday-only cron stranded a missed week forever, and its UTC schedule
 * only covered MYT Tue 08:00–Wed 07:00 anyway.
 */
export default async function closeReferralWeekJob(container: MedusaContainer) {
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
  const log = (message: string) => {
    try {
      container.resolve(ContainerRegistrationKeys.LOGGER).info(message);
    } catch {
      // logger unavailable in test containers — ignore
    }
  };

  const result = await packs.closeReferralWeek();
  if (result.created) {
    log(
      `[close-referral-week] settlement ${result.settlementId} created with ${result.lines} line(s)`,
    );
  }
}

export const config = {
  name: 'close-referral-week',
  schedule: '0 * * * *', // hourly, every day — see the self-heal note above
};
