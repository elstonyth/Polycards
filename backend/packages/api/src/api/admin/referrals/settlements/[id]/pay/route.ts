import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';

// POST /admin/referrals/settlements/:id/pay — "Pay now": runs the Wednesday
// step early for one approved run. Same idempotent path the cron takes, same
// deleted-account handling.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const pending = await packs.listWeeklySettlementLines(
    { settlement_id: req.params.id, status: 'pending' },
    { select: ['customer_id'], take: 100_000 },
  );
  const deleted = await packs.deletedCustomerIds([
    ...new Set(pending.map((l) => l.customer_id)),
  ]);
  const result = await packs.payWeeklySettlement({
    settlementId: req.params.id,
    skipCustomerIds: [...deleted],
  });
  res.json(result);
}
