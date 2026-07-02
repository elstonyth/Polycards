import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params;
  const { limit, offset } = parsePaginationParams({
    limit: req.query.limit,
    offset: req.query.offset,
  });
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json(await packs.auditForCustomer(id, { limit, offset }));
}
