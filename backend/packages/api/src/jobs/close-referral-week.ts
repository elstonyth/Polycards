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
 * Hourly on Tuesdays rather than once: the unique week_start makes every run
 * after the first a no-op, and hourly retries ride out a deploy or DB blip
 * landing exactly on the weekly boundary (same reasoning as
 * settle-challenge-week's hourly schedule).
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
  schedule: '0 * * * 2', // hourly on Tuesdays; the unique week_start makes extra runs no-ops
};
