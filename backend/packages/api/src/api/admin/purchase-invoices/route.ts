import type {
  AuthenticatedMedusaRequest,
  MedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
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

  // Existence gate: validate.ts checks card_handle is a non-empty string, not
  // that it resolves to anything. An unresolvable handle used to post a fully
  // successful 201 whose cost basis + stock_movement audit row attach to a
  // phantom key: invisible on the Inventory list (PRODUCT-grained, see
  // inventory-view.ts:59-64) and on_hand never rises. Resolve against PRODUCT
  // handles, never Card — a Product with no Card row (the PriceCharting
  // importer's output) is a legitimate purchase target, and a cards-only
  // check would 400 it.
  //
  // Reversal carve-out: a reversal's lines may ALSO name a handle whose
  // product was deleted after the original purchase. That is safe to allow
  // here because assertReversalCovered (service.ts, inside the workflow's own
  // transaction) independently rejects any handle that isn't actually on the
  // target invoice — this union can't let an unrelated/bogus handle through.
  const productModule = req.scope.resolve(Modules.PRODUCT);
  const requestedHandles = [...new Set(body.lines.map((l) => l.card_handle))];
  const products = await productModule.listProducts(
    { handle: requestedHandles },
    { take: requestedHandles.length, select: ['handle'] },
  );
  const validHandles = new Set(products.map((p) => p.handle));
  if (body.reverses_invoice_id) {
    const targetLines = await pageAll((opts) =>
      packs.listPurchaseInvoiceLines(
        { invoice_id: [body.reverses_invoice_id as string] },
        opts,
      ),
    );
    for (const l of targetLines) validHandles.add(l.card_handle);
  }
  const unknown = body.lines
    .map((l, i) => ({ i, card_handle: l.card_handle }))
    .filter(({ card_handle }) => !validHandles.has(card_handle));
  if (unknown.length) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Unknown card_handle — no matching product for ${unknown
        .map(({ i, card_handle }) => `lines[${i}] ('${card_handle}')`)
        .join(', ')}.`,
    );
  }

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
  // Truncated FIRST, escaped SECOND: escaping before the cut could sever an
  // escape pair and hand Postgres a dangling escape character.
  const q =
    typeof rawQ === 'string' && rawQ.trim() !== ''
      ? rawQ
          .trim()
          .slice(0, 100)
          .replace(/[\\%_]/g, (c) => `\\${c}`)
      : undefined;
  const rawSort =
    typeof req.query.sort === 'string' ? req.query.sort : 'created_at:desc';
  const [sortKey, sortDir] = rawSort.split(':');
  const orderKey = SORTABLE.has(sortKey) ? sortKey : 'created_at';
  const orderDir = sortDir === 'asc' ? 'ASC' : 'DESC';

  // $ilike (not $like) for the same reason as admin/delivery-orders/route.ts:29
  // — operators paste ?q= off a slip, in whatever case they typed it. `q` is
  // the MIDDLE of a LIKE pattern, so `%`, `_` and `\` are escaped above the
  // same way that precedent does it (delivery-orders/validate.ts:52). Not an
  // injection fix — the value is bound. Unescaped, `?q=%` builds `%%%` and
  // returns the WHOLE table while the operator believes they filtered, and a
  // supplier genuinely named `A_B Trading` over-matches `AXB Trading`.
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
        // sen * integer qty stays exact — never toSen(fmv * qty). That holds
        // ONLY because validate.ts:114 caps fmv_snapshot at 2dp. At 3dp the
        // rejected form is the correct one: fmv=300.005 qty=1000 ships 300010
        // where exact is 300005, an RM 5 error. Widen that cap and this line
        // has to change with it.
        total_fmv: fromSen(
          invLines.reduce((s, l) => s + toSen(l.fmv_snapshot) * Number(l.qty), 0),
        ),
      };
    }),
  });
}
