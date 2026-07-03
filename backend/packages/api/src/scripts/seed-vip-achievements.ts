import { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import type PacksModuleService from '../modules/packs/service';
import { PACKS_MODULE } from '../modules/packs';
import { VIP_LEVELS } from './vip-levels.data';
import { ACHIEVEMENT_DEFS } from './achievement-defs.data';

// Targeted reference-data seed: VIP ladder + achievement definitions ONLY.
// Prod deploys run migrations but never the full seed, so these two tables end
// up empty there — the VIP page then shows "top level" at level 1 and 0/0
// achievements. Same idempotent upsert-if-absent blocks as seed.ts (by `level`
// / `key`), safe to re-run anywhere:
//   corepack yarn medusa exec ./src/scripts/seed-vip-achievements.ts
export default async function seedVipAchievements({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

  const existingVipLevels = await packs.listVipLevels(
    { level: VIP_LEVELS.map((r) => r.level) },
    { select: ['level'], take: VIP_LEVELS.length },
  );
  const haveLevels = new Set(existingVipLevels.map((r) => r.level));
  const vipLevelsToCreate = VIP_LEVELS.filter((r) => !haveLevels.has(r.level));
  if (vipLevelsToCreate.length === 0) {
    logger.info('VIP levels already exist, skipping.');
  } else {
    await packs.createVipLevels(vipLevelsToCreate.map((r) => ({ ...r })));
    logger.info(`Seeded ${vipLevelsToCreate.length} VIP levels.`);
  }

  const existingAchDefs = await packs.listAchievementDefs(
    { key: ACHIEVEMENT_DEFS.map((d) => d.key) },
    { select: ['key'], take: ACHIEVEMENT_DEFS.length },
  );
  const haveAchKeys = new Set(existingAchDefs.map((d) => d.key));
  const achDefsToCreate = ACHIEVEMENT_DEFS.filter(
    (d) => !haveAchKeys.has(d.key),
  );
  if (achDefsToCreate.length === 0) {
    logger.info('Achievement defs already exist, skipping.');
  } else {
    await packs.createAchievementDefs(achDefsToCreate.map((d) => ({ ...d })));
    logger.info(`Seeded ${achDefsToCreate.length} achievement defs.`);
  }
}
