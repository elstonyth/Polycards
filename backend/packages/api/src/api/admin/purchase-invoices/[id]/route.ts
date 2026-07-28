import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { IUserModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { pageAll } from '../../../utils/page-all';

// GET /admin/purchase-invoices/:id — full detail view (POLYCARD-BACK §3.5).
// Read-only: an invoice is immutable, corrections are a second (reversing)
// invoice, so there is deliberately no PUT/DELETE sibling here. That also
// keeps the soft-delete hazard flagged at service.ts assertReversalCovered
// dormant — nothing on this route can hand reversal budget back.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const [invoice] = await packs.listPurchaseInvoices({ id }, { take: 1 });
  if (!invoice) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Purchase invoice '${id}' not found.`,
    );
  }
  // PAGED, not a take: cap — the detail view is what an operator reconciles a
  // paper invoice against, so a silently short line list is the worst outcome.
  const lines = await pageAll(
    (opts) => packs.listPurchaseInvoiceLines({ invoice_id: id }, opts),
    { created_at: 'ASC', id: 'ASC' },
  );
  // Join the admin email the same way the LIST route does: agent_user_id is
  // an actor id, and both pages show a person. Without this the detail page
  // can only render a raw usr_01... id while the list beside it shows an
  // email, which reads as two different agents for one invoice.
  const users = req.scope.resolve<IUserModuleService>(Modules.USER);
  const [agent] = await users.listUsers(
    { id: invoice.agent_user_id },
    { take: 1 },
  );
  res.json({
    invoice: { ...invoice, agent_email: agent?.email ?? null, lines },
  });
}
