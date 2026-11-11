import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import type { IUserModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { resolveFxRateStrict } from '../../../../modules/packs/pricing';
import { updatePurchaseInvoiceWorkflow } from '../../../../workflows/update-purchase-invoice';
import { pageAll } from '../../../utils/page-all';
import { coerceEditPurchaseInvoiceBody } from '../validate';

// GET /admin/purchase-invoices/:id — full detail view (POLYCARD-BACK §3.5),
// plus the reversal that undid it, if any (`reversed_by`): the page shows
// Edit only while there is none. There is deliberately no DELETE sibling —
// a whole invoice is still undone by a second (reversing) invoice, which
// keeps the soft-delete hazard flagged at service.ts assertReversalCovered
// dormant.
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
  const [grn] = invoice.from_grn_id
    ? await packs.listGoodsReceiveNotes(
        { id: invoice.from_grn_id },
        { take: 1, select: ['id', 'display_no'] },
      )
    : [];
  const [reversal] = await packs.listPurchaseInvoices(
    { reverses_invoice_id: id },
    { take: 1, select: ['id', 'display_no'] },
  );
  res.json({
    invoice: {
      ...invoice,
      agent_email: agent?.email ?? null,
      from_grn_display_no: grn?.display_no ?? null,
      reversed_by: reversal
        ? { id: reversal.id, display_no: reversal.display_no }
        : null,
      lines,
    },
  });
}

// POST /admin/purchase-invoices/:id — edit an invoice (user 2026-11-11):
// date, supplier and every line, with the same body and checks as a new
// purchase. A reversal, an invoice already reversed, or a save over someone
// else's is refused under the invoice's lock
// (service.updatePurchaseInvoiceWithLines); an invoice transferred from a
// goods receive note may change its date, supplier and unit costs only.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = coerceEditPurchaseInvoiceBody(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Same FX gate as a new invoice: the form's FMV prefill is priced off it.
  await resolveFxRateStrict(packs);

  // Same existence gate as a new invoice. Handles already on this invoice
  // pass even if their product was deleted since, so fixing a date never
  // forces a card off (the GRN edit's allowance).
  const current = await pageAll((opts) =>
    packs.listPurchaseInvoiceLines({ invoice_id: req.params.id }, opts),
  );
  const handles = [...new Set(body.lines.map((l) => l.card_handle))];
  const products = await req.scope
    .resolve(Modules.PRODUCT)
    .listProducts(
      { handle: handles },
      { take: handles.length, select: ['handle'] },
    );
  const valid = new Set([
    ...products.map((p) => p.handle),
    ...current.map((l) => l.card_handle),
  ]);
  const unknown = body.lines
    .map((l, i) => ({ i, card_handle: l.card_handle }))
    .filter(({ card_handle }) => !valid.has(card_handle));
  if (unknown.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Unknown card_handle — no matching product for ${unknown
        .map(({ i, card_handle }) => `lines[${i}] ('${card_handle}')`)
        .join(', ')}.`,
    );
  }

  const { result } = await updatePurchaseInvoiceWorkflow(req.scope).run({
    input: {
      invoice_id: req.params.id,
      date: body.date,
      supplier: body.supplier,
      agent_user_id: req.auth_context.actor_id,
      expected_updated_at: body.expected_updated_at,
      lines: body.lines,
    },
  });
  // `delta` is the counter step's input, not part of the invoice.
  const { delta: _delta, ...invoice } = result;
  res.json({ invoice });
}
