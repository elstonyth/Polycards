import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { describeGrns } from '../view';

// GET /admin/goods-receive-notes/:id — one GRN with its lines, its status and
// the invoice / reversal it is linked to.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [grn] = await packs.listGoodsReceiveNotes(
    { id: req.params.id },
    { take: 1 },
  );
  if (!grn) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Goods receive note '${req.params.id}' not found.`,
    );
  }
  const [row] = await describeGrns(req.scope, [grn]);
  res.json({ goods_receive_note: row });
}
