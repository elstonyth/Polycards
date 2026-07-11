import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import { saveDailyBoxWorkflow } from '../workflows/save-daily-box';

// Enable the tier-'a' daily reward box so POST /store/daily/draw actually draws
// in the sim. New customers resolve to tier 'a' (vip-levels.data.ts level 1),
// whose box ships disabled with no prizes by default — which made the pilot's
// daily draw return {status:'unavailable'} and blocked the Day1→Day2 time-shift
// proof. Credit + nothing prizes only (no product handle needed); pct sums 100.
// Run: medusa exec ./src/scripts/seed-sim-daily-box.ts  (against the sim DB)
export default async function seedSimDailyBox({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  logger.info('[sim] enabling tier-a daily box…');
  await saveDailyBoxWorkflow(container).run({
    input: {
      tier: 'a',
      admin_id: 'seed-sim-daily-box',
      body: {
        name: 'Tier A Reward Box (sim)',
        enabled: true,
        draws_per_day: 3,
        reason: 'sim daily-draw seed',
        prizes: [
          { kind: 'credit', locked: true, pct: 35, amount_myr: 2 },
          { kind: 'nothing', locked: true, pct: 65 },
        ],
      },
    },
  });
  logger.info('[sim] tier-a daily box enabled (35% RM2 credit, 65% nothing).');
}
