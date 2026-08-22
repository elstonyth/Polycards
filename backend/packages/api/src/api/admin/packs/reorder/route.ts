import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { reorderPacksWorkflow } from '../../../../workflows/reorder-packs';
import { coerceReorderBody } from '../validate';
import { clearPackListCache } from '../../../store/packs/route';
import { clearPackDetailCache } from '../../../store/packs/[slug]/route';
import { clearAdminPackListCache } from '../route';

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

  // Rank drives BOTH list orders — bust the 30s read caches IN THIS PROCESS.
  // The new order is immediate on this instance; the other instance rolls
  // over on its own ≤30s window (#473 runs 2), same as every other admin
  // pack write.
  clearPackListCache();
  clearPackDetailCache();
  clearAdminPackListCache();
  res.json(result);
}
