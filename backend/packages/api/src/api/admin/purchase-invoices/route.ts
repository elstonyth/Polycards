import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRateStrict } from '../../../modules/packs/pricing';
import { createPurchaseInvoiceWorkflow } from '../../../workflows/create-purchase-invoice';
import { coerceCreatePurchaseInvoiceBody } from './validate';

// POST /admin/purchase-invoices — record a receipt (POLYCARD-BACK §3.5).
// agent_user_id is server-derived (never client-supplied).
//
// Cross-invoice reversal validation deliberately does NOT live here. It is a
// read-then-write, so running it in this handler and the write in the
// workflow's transaction left a window where two concurrent POSTs of the same
// reversal both passed — verified, ten units bought and twenty reversed. It now
// runs under an advisory lock inside the very transaction that writes the
// invoice: PacksModuleService.assertReversalCovered.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = coerceCreatePurchaseInvoiceBody(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  // fmv_snapshot is a frozen MONEY record, and the client (admin UI) already
  // priced it — this call does NOT recompute/override that number, it is a
  // GATE: refuse the whole invoice (throws NOT_ALLOWED) when no firm FX rate
  // exists at all, rather than letting a purchase silently record an FMV
  // that was priced off the 4.7 display fallback during an FX-empty window.
  // Resolved HERE, before the workflow opens its transaction — resolving it
  // inside would take a second pool connection.
  await resolveFxRateStrict(packs);

  const { result } = await createPurchaseInvoiceWorkflow(req.scope).run({
    input: {
      date: body.date,
      supplier: body.supplier,
      agent_user_id: req.auth_context.actor_id,
      reverses_invoice_id: body.reverses_invoice_id,
      lines: body.lines,
    },
  });

  await packs.createAdminActionAudits([
    {
      admin_id: req.auth_context.actor_id,
      entity_type: 'purchase_invoice',
      entity_id: result.id,
      action: 'create',
      before: null,
      after: { display_no: result.display_no, lines: result.lines.length },
      reason: body.reverses_invoice_id
        ? `reversal of invoice ${body.reverses_invoice_id}`
        : 'purchase invoice created',
    },
  ]);

  res.status(201).json({ invoice: result });
}
