import { MedusaError } from '@medusajs/framework/utils';
import type { AuthenticatedMedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { validateAchievementDef } from '../../../modules/packs/achievements-validate';

export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const defs = await packs.listAchievementDefs({}, { take: 10000 });
  const sorted = [...defs].sort((a, b) => Number(a.xp) - Number(b.xp));
  res.json({ defs: sorted });
}

export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const body = validateAchievementDef(req.body);
  const key = (req.body as { key?: string })['key'];
  if (!key || typeof key !== 'string')
    throw new MedusaError(MedusaError.Types.INVALID_DATA, 'key is required');
  const [created] = await packs.createAchievementDefs([{ key, ...body }]);
  // ponytail: createAchievementDefs returns InferTypeOf[] — [0] is safe; empty = DB constraint violation caught by Medusa
  res.status(201).json({ def: created });
}
