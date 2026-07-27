import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';

// GET /admin/customers/:id/spend-report — the customer's pack_open spend per
// calendar month (MYR), newest first, at most 24 months. Months are bucketed in
// Asia/Kuala_Lumpur and months without an open are omitted; the whole contract
// (ordering + cap) lives in the service's single SQL aggregate.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  res.json({ periods: await packs.spendReportForCustomer(req.params.id) });
}
