import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { ICustomerModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../../modules/packs';
import type PacksModuleService from '../../../../../modules/packs/service';
import { enrichCustomers } from '../../../../../utils/enrich-customers';
import { parsePaginationParams } from '../../../../../utils/pagination';

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const { id } = req.params;
  const { limit, offset } = parsePaginationParams({
    limit: req.query.limit,
    offset: req.query.offset,
  });

  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.commissionsForBeneficiary(id, { limit, offset });

  const openerIds = [...new Set(rows.map((r) => r.opener_customer_id).filter(Boolean) as string[])];
  const customerService = req.scope.resolve<ICustomerModuleService>(Modules.CUSTOMER);
  const idMap = await enrichCustomers(openerIds, customerService);

  res.json({
    commissions: rows.map((r) => ({
      id: r.id, generation: r.generation, kind: r.kind, status: r.status,
      amount: r.amount, reason: r.reason, matures_at: r.matures_at,
      reversal_transaction_id: r.reversal_transaction_id,
      source_transaction_id: r.source_transaction_id,
      opener: {
        customer_id: r.opener_customer_id,
        handle: r.opener_customer_id ? (idMap.get(r.opener_customer_id)?.handle ?? null) : null,
      },
      created_at: r.created_at,
    })),
  });
}
