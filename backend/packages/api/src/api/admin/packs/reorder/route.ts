import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { reorderPacksWorkflow } from '../../../../workflows/reorder-packs';
import { coerceReorderBody } from '../validate';
import { clearPackListCache } from '../../../store/packs/route';
import { clearPackDetailCache } from '../../../store/packs/[slug]/route';

// POST /admin/packs/reorder — persist the packs-list order as ONE batch of
// rank writes (all-or-nothing). Replaces the old N-parallel full-payload
// updates, which half-applied a swap whenever one row tripped the activation
// guard. Rank never affects rollability, so no guard runs here.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const input = coerceReorderBody(req.body ?? {});

  const { result } = await reorderPacksWorkflow(req.scope).run({ input });

  // Rank drives the storefront list order — bust the 30s read caches so the
  // new order shows immediately, same as every other admin pack write.
  clearPackListCache();
  clearPackDetailCache();
  res.json(result);
}
