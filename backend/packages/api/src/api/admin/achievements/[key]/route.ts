import { MedusaError } from '@medusajs/framework/utils';
import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { validateAchievementDef } from '../../../../modules/packs/achievements-validate';

export async function PUT(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const { key } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [existing] = await packs.listAchievementDefs({ key }, { take: 1 });
  if (!existing) throw new MedusaError(MedusaError.Types.NOT_FOUND, `No achievement '${key}'`);
  const body = validateAchievementDef(req.body);
  const [updated] = await packs.updateAchievementDefs([{ id: existing.id, ...body }]);
  res.json({ def: updated });
}
