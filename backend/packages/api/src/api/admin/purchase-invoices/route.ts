import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import type { IUserModuleService } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../../../modules/packs';
import type PacksModuleService from '../../../modules/packs/service';
import { resolveFxRateStrict } from '../../../modules/packs/pricing';
import { createPurchaseInvoiceWorkflow } from '../../../workflows/create-purchase-invoice';
import { fromSen, toSen } from '../../../modules/packs/money';
import { pageAll } from '../../utils/page-all';
import { parsePaginationParams } from '../../../utils/pagination';
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

// Sortable columns are an allowlist, not a passthrough — `order` goes straight
// into the query builder.
const SORTABLE = new Set(['created_at', 'date', 'display_no', 'supplier']);

// GET /admin/purchase-invoices — the Inventory > Purchases table
// (POLYCARD-BACK §3.5). Header row + the three totals the table shows, folded
// per page. No FX anywhere on this path: every column here is already MYR.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );
  const rawQ = req.query.q;
  const q =
    typeof rawQ === 'string' && rawQ.trim() !== ''
      ? rawQ.trim().slice(0, 100)
      : undefined;
  const rawSort =
    typeof req.query.sort === 'string' ? req.query.sort : 'created_at:desc';
  const [sortKey, sortDir] = rawSort.split(':');
  const orderKey = SORTABLE.has(sortKey) ? sortKey : 'created_at';
  const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';

  // $ilike (not $like) for the same reason as admin/delivery-orders/route.ts:29
  // — operators paste ?q= off a slip, in whatever case they typed it.
  const filter = q
    ? {
        $or: [
          { supplier: { $ilike: `%${q}%` } },
          { display_no: { $ilike: `%${q}%` } },
        ],
      }
    : {};

  const [invoices, total] = await packs.listAndCountPurchaseInvoices(filter, {
    // `id` is the tiebreaker, not decoration: `date` and `display_no` are both
    // non-unique enough to reorder rows across pages without it (see pageAll's
    // docstring for the same rule).
    order: { [orderKey]: orderDir, id: orderDir },
    skip: offset,
    take: limit,
  });

  const ids = invoices.map((i) => i.id);
  // PAGED, not a take: cap. subtotal/total_fmv are money — a truncated line
  // list would render a wrong number that looks entirely plausible.
  const lines = ids.length
    ? await pageAll((opts) =>
        packs.listPurchaseInvoiceLines({ invoice_id: ids }, opts),
      )
    : [];
  const linesByInvoice = new Map<string, typeof lines>();
  for (const l of lines) {
    const list = linesByInvoice.get(l.invoice_id) ?? [];
    list.push(l);
    linesByInvoice.set(l.invoice_id, list);
  }

  // Join admin emails: agent_user_id is an actor id, and the table shows a
  // person. Mirrors the customer-email join in admin/delivery-orders.
  const users = req.scope.resolve<IUserModuleService>(Modules.USER);
  const agentIds = [...new Set(invoices.map((i) => i.agent_user_id))];
  const agents = agentIds.length
    ? await users.listUsers({ id: agentIds }, { take: agentIds.length })
    : [];
  const emailByUserId = new Map(agents.map((u) => [u.id, u.email]));

  res.json({
    total,
    offset,
    limit,
    invoices: invoices.map((inv) => {
      const invLines = linesByInvoice.get(inv.id) ?? [];
      return {
        id: inv.id,
        display_no: inv.display_no,
        date: inv.date,
        supplier: inv.supplier,
        agent_user_id: inv.agent_user_id,
        agent_email: emailByUserId.get(inv.agent_user_id) ?? null,
        reverses_invoice_id: inv.reverses_invoice_id,
        created_at: inv.created_at,
        total_qty: invLines.reduce((s, l) => s + Number(l.qty), 0),
        // Summed in integer sen: reversal lines are negative, and toSen rounds
        // half AWAY from zero so a -0.005 line doesn't drift the other way.
        subtotal: fromSen(
          invLines.reduce((s, l) => s + toSen(l.line_total), 0),
        ),
        // sen * integer qty stays exact — never toSen(fmv * qty).
        total_fmv: fromSen(
          invLines.reduce((s, l) => s + toSen(l.fmv_snapshot) * Number(l.qty), 0),
        ),
      };
    }),
  });
}
