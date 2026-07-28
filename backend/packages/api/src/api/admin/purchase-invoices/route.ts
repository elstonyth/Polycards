import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRateStrict } from '../../../modules/packs/pricing';
import { toSen } from '../../../modules/packs/money';
import { pageAll } from '../../utils/page-all';
import { createPurchaseInvoiceWorkflow } from '../../../workflows/create-purchase-invoice';
import {
  coerceCreatePurchaseInvoiceBody,
  type CreatePurchaseInvoiceBody,
} from './validate';

const bad = (message: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, message);
};

// D8's reversal identity: a line is matched by card_handle AND unit_cost, never
// FIFO/LIFO (operator decision). Keyed on INTEGER SEN rather than the raw
// number so a DB `numeric` round-trip ("150.0000") and the validator's already
// 2dp-normalized body value can never miss each other on a float compare.
const costKey = (card_handle: string, unit_cost: unknown): string =>
  `${card_handle}|${toSen(unit_cost)}`;

type CostQtyLine = { card_handle: string; unit_cost: unknown; qty: unknown };

// Σ qty per (card_handle, unit_cost). Signed, so folding a target invoice
// together with every reversal already booked against it yields exactly what
// is still un-reversed.
const sumQtyByCostKey = (lines: CostQtyLine[]): Map<string, number> => {
  const out = new Map<string, number>();
  for (const l of lines) {
    const key = costKey(l.card_handle, l.unit_cost);
    out.set(key, (out.get(key) ?? 0) + Number(l.qty));
  }
  return out;
};

// Cross-invoice validation for a reversing invoice — everything the pure
// validator cannot do because it needs the DB. Runs entirely BEFORE the
// workflow opens its transaction (a read inside would take a second pool
// connection).
//
// Matching alone is not enough: the same fully-matching reversal body can be
// POSTed twice, or a reversal can name a qty larger than was ever purchased.
// Both pass a per-line "does this handle+unit_cost exist on the target" test
// and both silently corrupt the D8 weighted average and the on-hand counter.
// So the real invariant is a BUDGET: for every (card_handle, unit_cost), what
// the target bought, minus everything prior reversals of that same target
// already took back, must still cover this body. reverses_invoice_id is what
// makes that sum knowable — it is why the column exists.
//
// ponytail: read-then-write, so two simultaneous reversals of the same invoice
// could each see the full budget. One operator with one admin UI makes that
// unreachable in practice; if it ever matters, wrap this + the workflow in the
// pg_advisory_xact_lock idiom service.ts already uses for the credit ledger.
async function assertReversalIsCovered(
  packs: PacksModuleService,
  body: CreatePurchaseInvoiceBody & { reverses_invoice_id: string },
): Promise<void> {
  const [target] = await packs.listPurchaseInvoices(
    { id: body.reverses_invoice_id },
    { take: 1 },
  );
  if (!target) {
    bad("'reverses_invoice_id' does not match an existing invoice.");
  }
  // A reversal of a reversal would need positive-qty lines to undo the
  // negative ones, which the validator forbids outright — so anything that
  // reaches here would double-subtract. Reverse the ORIGINAL instead.
  if (target.reverses_invoice_id) {
    bad(
      `Invoice ${target.display_no} is itself a reversing invoice and cannot be reversed — reverse the original.`,
    );
  }

  const priorReversals = await pageAll((opts) =>
    packs.listPurchaseInvoices({ reverses_invoice_id: target.id }, opts),
  );
  const invoiceIds = [target.id, ...priorReversals.map((r) => r.id)];
  const lines = await pageAll((opts) =>
    packs.listPurchaseInvoiceLines({ invoice_id: invoiceIds }, opts),
  );

  const remaining = sumQtyByCostKey(lines);
  const onTarget = new Set(
    lines
      .filter((l) => l.invoice_id === target.id)
      .map((l) => costKey(l.card_handle, l.unit_cost)),
  );

  // Fold the incoming body the same way FIRST: two lines in one body for the
  // same handle+unit_cost must be spent against a single budget, not checked
  // twice against the full one.
  const requested = new Map<
    string,
    { card_handle: string; unit_cost: number; qty: number }
  >();
  for (const line of body.lines) {
    const key = costKey(line.card_handle, line.unit_cost);
    const prev = requested.get(key);
    if (prev) {
      prev.qty += line.qty;
    } else {
      requested.set(key, { ...line });
    }
  }

  for (const [key, want] of requested) {
    if (!onTarget.has(key)) {
      bad(
        `Reversal line for '${want.card_handle}' at unit_cost ${want.unit_cost} does not match any line on invoice ${target.display_no}.`,
      );
    }
    const left = remaining.get(key) ?? 0;
    // want.qty is negative; `left` is what the target still has un-reversed.
    if (left + want.qty < 0) {
      bad(
        `Reversing ${-want.qty} of '${want.card_handle}' at unit_cost ${want.unit_cost} exceeds the ${left} still un-reversed on invoice ${target.display_no}.`,
      );
    }
  }
}

// POST /admin/purchase-invoices — record a receipt (POLYCARD-BACK §3.5).
// agent_user_id is server-derived (never client-supplied).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const body = coerceCreatePurchaseInvoiceBody(req.body);
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);

  if (body.reverses_invoice_id !== null) {
    await assertReversalIsCovered(packs, {
      ...body,
      reverses_invoice_id: body.reverses_invoice_id,
    });
    // Deliberately one-directional: every reversal line must be covered by the
    // target (checked above), but the converse is NOT required — a target line
    // with no corresponding reversal line just means that line wasn't part of
    // this correction. Partial reversals are legal.
  }

  // fmv_snapshot is a frozen MONEY record, and the client (admin UI) already
  // priced it — this call does NOT recompute/override that number, it is a
  // GATE: refuse the whole invoice (throws NOT_ALLOWED) when no firm FX rate
  // exists at all, rather than letting a purchase silently record an FMV
  // that was priced off the 4.7 display fallback during an FX-empty window.
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
