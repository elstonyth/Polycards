import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { parsePaginationParams } from '../../../../../utils/pagination';

// GET /admin/customers/:id/transactions — paginated credit ledger for the
// support view. Same row shape as the gacha route's `transactions` slice.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 25, maxLimit: 100 },
  );
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [rows, total] = await packs.listAndCountCreditTransactions(
    { customer_id: id },
    { order: { created_at: 'DESC' }, skip: offset, take: limit },
  );
  res.json({
    total,
    items: rows.map((t: any) => ({
      id: t.id,
      amount: Number(t.amount),
      reason: t.reason,
      reference: t.reference ?? null,
      created_at: t.created_at,
    })),
  });
}
