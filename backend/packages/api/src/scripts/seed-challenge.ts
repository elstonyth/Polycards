/**
 * seed-challenge.ts
 *
 * Demo seed for the Weekly Pulled Value Challenge the storefront /task page
 * renders (GET /store/challenge). Writes the cumulative milestone ladder (the
 * top-10 prize pool: cards → ranks 1-3, credits → ranks 4-10) + the weekly
 * reset through the SAME audited service methods the admin "Weekly Challenge"
 * page uses (saveChallengeStages / editChallengeSettings), so it exercises the
 * real validation path (featured card ids must exist).
 *
 * Featured cards are pulled from whatever catalog exists in the local DB, so the
 * seed self-adjusts — no hardcoded card ids. With zero cards it still seeds the
 * ladder (empty featured lists), which is valid.
 *
 * RUN (backend must be up):
 *   corepack yarn medusa exec ./src/scripts/seed-challenge.ts
 *
 * Idempotent: saveChallengeStages is a whole-set replace and editChallengeSettings
 * patches the singleton, so re-running just re-writes the same demo config.
 */
import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';

const ADMIN_ID = 'seed-challenge';
const REASON = 'Demo seed (seed-challenge.ts)';

export default async function seedChallenge({
  container,
}: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  // Real card ids from the local catalog — used as featured/payout cards. The
  // audited service methods reject unknown ids, so these MUST exist.
  const cards = await packs.listCards(
    {},
    { select: ['id', 'name'], take: 8 },
  );
  if (cards.length === 0) {
    logger.warn(
      '[seed-challenge] No cards found — seeding the ladder with no featured cards. Run seed.ts first for card art.',
    );
  }
  const at = (i: number): string | undefined => cards[i % cards.length]?.id;
  // Three CONSECUTIVE catalog cards (mod length) — distinct for any catalog of
  // 3+, so every stage always fills its #1st/#2nd/#3rd podium tiles (arbitrary
  // index sets collide mod small catalogs; the dev DB has only 3 cards).
  const trio = (start: number): string[] =>
    cards.length === 0
      ? []
      : [
          ...new Set(
            [at(start), at(start + 1), at(start + 2)].filter(
              (x): x is string => Boolean(x),
            ),
          ),
        ];

  // Milestone stages — strictly increasing thresholds (the validator requires
  // it). RM values; reward_credits are RM credits granted at each milestone.
  // Sized so the current dev-DB pool (~RM 380k pulled this week) sits mid-
  // ladder — stages 1-2 cleared, stage 3 in progress — for a truthful demo.
  // THREE cards per stage, ORDERED: reward_card_ids[0] is the #1st-place
  // featured card, [1] → #2nd, [2] → #3rd (the storefront prize grid).
  const stages = [
    { stage_number: 1, threshold_myr: 100_000, reward_credits: 1_000, reward_card_ids: trio(0) },
    { stage_number: 2, threshold_myr: 250_000, reward_credits: 2_500, reward_card_ids: trio(3) },
    { stage_number: 3, threshold_myr: 500_000, reward_credits: 5_000, reward_card_ids: trio(6) },
    { stage_number: 4, threshold_myr: 1_000_000, reward_credits: 10_000, reward_card_ids: trio(9) },
  ];

  await packs.saveChallengeStages({ stages, adminId: ADMIN_ID, reason: REASON });
  logger.info(`[seed-challenge] Wrote ${stages.length} milestone stages.`);

  // Week & reset: Monday 00:00 Asia/Kuala_Lumpur (reset_day 1 = Monday). No
  // flat payout — the prize pool is the cumulative unlocked stage rewards.
  await packs.editChallengeSettings({
    patch: {
      cadence: 'fixed_weekly',
      timezone: 'Asia/Kuala_Lumpur',
      reset_day: 1,
      reset_hour: 0,
    },
    adminId: ADMIN_ID,
    reason: REASON,
  });
  logger.info('[seed-challenge] Wrote week & reset (Monday 00:00 MYT). Done.');
}
