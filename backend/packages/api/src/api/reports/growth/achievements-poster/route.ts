import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import {
  ACHIEVEMENTS_MAX_TILES,
  renderAchievementsPoster,
} from '../../../../modules/packs/achievements-poster';
import { taskCatalogue } from '../tasks/catalogue';

// GET /reports/growth/achievements-poster?min_level&max_level: the live
// VIP-level achievements (reach_level) as a finished ladder poster, one tile
// per level with the prize's official picture and what /task says it is
// worth (modules/packs/achievements-poster.ts). Nothing on it is typed in.
// x-poster-levels lists the levels drawn; x-poster-missing-art the levels
// whose picture could not be loaded (drawn as a plain gift box);
// x-poster-skipped the levels left off because their prize is gone. Art is
// fetched from the stored paths, which fetchBytes resolves itself.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const level = (name: string, fallback: number): number => {
    const raw = req.query[name];
    if (raw === undefined) return fallback;
    if (
      typeof raw !== 'string' ||
      !/^\d{1,3}$/.test(raw) ||
      Number(raw) < 1 ||
      Number(raw) > 100
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `${name} must be a VIP level from 1 to 100.`,
      );
    }
    return Number(raw);
  };
  const min = level('min_level', 1);
  const max = level('max_level', 100);
  if (min > max) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'min_level must not be above max_level.',
    );
  }

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const ladder = (await taskCatalogue(packs)).tasks.filter(
    (t): t is typeof t & { level: number } =>
      t.kind === 'achievement' && t.level !== null,
  );
  const inRange = ladder.filter((t) => t.level >= min && t.level <= max);
  // A free rip or card whose pack or card is gone (the only way /task shows
  // no value for one) cannot be claimed, so it never goes on a public
  // poster; x-poster-skipped names those levels for staff to fix.
  const gone = (t: (typeof ladder)[number]) =>
    t.prize_type !== 'credit' && t.value_myr === null;
  const skipped = inRange.filter(gone).map((t) => t.level);
  const shown = inRange.filter((t) => !gone(t));
  if (!shown.length && skipped.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Every achievement from Lv.${min} to Lv.${max} has a prize that no longer exists (Lv.${skipped.join(', Lv.')}): fix them in the admin Tasks console.`,
    );
  }
  if (!shown.length) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      ladder.length
        ? `No live VIP-level achievement from Lv.${min} to Lv.${max}. Live levels: ${ladder.map((t) => t.level).join(', ')}.`
        : 'There are no live VIP-level achievements.',
    );
  }
  if (shown.length > ACHIEVEMENTS_MAX_TILES) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `That is ${shown.length} achievements and a poster fits ${ACHIEVEMENTS_MAX_TILES}: narrow it with min_level and max_level. Live levels: ${ladder.map((t) => t.level).join(', ')}.`,
    );
  }

  const { jpeg, missing } = await renderAchievementsPoster(
    {
      tiles: shown.map((t) => ({
        level: t.level,
        kind: t.prize_type,
        prize: t.prize,
        valueMyr: t.value_myr,
      })),
      siteHost: 'polycards.gg/task',
    },
    shown.map((t) => t.image),
  );
  res.setHeader('Content-Type', 'image/jpeg');
  res.setHeader('x-poster-levels', shown.map((t) => t.level).join(','));
  if (skipped.length) res.setHeader('x-poster-skipped', skipped.join(','));
  if (missing.length) res.setHeader('x-poster-missing-art', missing.join(','));
  res.status(200).send(jpeg);
}
