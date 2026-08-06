import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../modules/packs/globepay-reconcile';
import {
  parsePaginationParams,
  parseSortParam,
} from '../../../../utils/pagination';

// GET /admin/globepay/deposits — operator visibility into the GlobePay365
// deposit table.
//
// WHY this route exists: a deposit row is the ONLY record tying a payment at the
// gateway to a customer, and until now nothing in the dashboard could read it.
// The failure this covers is a customer who paid while both the callback and the
// reconciliation sweep missed: the money is at the gateway, the row sits
// 'pending' forever, and finding it meant hand-written SQL against production.
//
// Read-only on purpose. There is no settle/requery action here: the 10-minute
// sweep (jobs/globepay-reconcile.ts) is the authoritative repair path, and a
// manual "credit this" button would be a second, unaudited way to mint credit.
//
// Admin-only (auto-protected /admin/* route), so joining the customer email is
// legitimate operator visibility — the same call the Pull Ledger makes.

// 'all' is a view, not a stored status: it drops the status filter entirely.
const STATUS_FILTERS = ['pending', 'settled', 'failed', 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Unknown/absent status falls back to 'pending' — the view that matters. */
export function parseStatusFilter(raw: unknown): StatusFilter {
  return typeof raw === 'string' &&
    (STATUS_FILTERS as readonly string[]).includes(raw)
    ? (raw as StatusFilter)
    : 'pending';
}

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );
  const status = parseStatusFilter(req.query.status);

  // Sortable columns are an allowlist, not a passthrough — `order` goes
  // straight into the query builder. Real columns only: customer_email and
  // stale are computed in JS after the page is fetched.
  const SORTABLE = new Set(['created_at', 'amount_requested', 'settled_at']);

  // Pending sorts OLDEST first (the ['status','created_at'] index): the row most
  // likely to be a stranded payment is the one that has been waiting longest, so
  // it belongs at the top rather than buried on the last page. Every other view
  // is a history read, where newest-first is what an operator expects. That
  // status-dependent default only holds while the operator has NOT picked a
  // sort — an explicit `?sort=` overrides it (with the id tiebreaker so
  // non-unique amounts can't reorder rows across pages).
  let order: Record<string, 'ASC' | 'DESC'> = {
    created_at: status === 'pending' ? 'ASC' : 'DESC',
  };
  if (typeof req.query.sort === 'string') {
    const { key, dir } = parseSortParam(req.query.sort, SORTABLE, 'created_at');
    order = { [key]: dir, id: dir };
  }

  const [rows, total] = await packs.listAndCountGlobePayDeposits(
    status === 'all' ? {} : { status },
    { skip: offset, take: limit, order },
  );

  const customerIds = [
    ...new Set(
      rows.map((r) => r.customer_id).filter((id): id is string => !!id),
    ),
  ];
  const customers = customerIds.length
    ? await customerService.listCustomers(
        { id: customerIds },
        { take: customerIds.length },
      )
    : [];
  const emailById = new Map(customers.map((c) => [c.id, c.email]));

  // `stale` is computed here, from the SAME window the sweep uses, so the
  // dashboard and the job can never disagree about what counts as overdue. A
  // pending row past it means the sweep has had at least six chances to resolve
  // this deposit and has not — i.e. look at it by hand.
  const now = Date.now();
  const deposits = rows.map((r) => ({
    id: r.id,
    merchant_transaction_id: r.merchant_transaction_id,
    gateway_transaction_id: r.gateway_transaction_id,
    customer_id: r.customer_id,
    customer_email: emailById.get(r.customer_id) ?? null,
    // bigNumber columns come back as strings/BigNumber — normalize to a number
    // for display, exactly as the customer transaction routes do.
    amount_requested: Number(r.amount_requested),
    amount_settled:
      r.amount_settled === null || r.amount_settled === undefined
        ? null
        : Number(r.amount_settled),
    payment_method_code: r.payment_method_code,
    status: r.status,
    gateway_status: r.gateway_status,
    created_at: r.created_at,
    settled_at: r.settled_at,
    stale:
      r.status === 'pending' &&
      now - new Date(r.created_at).getTime() > GLOBEPAY_STALE_AFTER_MS,
  }));

  // Identity-varying response carrying emails
  // (CWE-524): a cached copy could outlive the admin session in a shared
  // browser profile. Same rule as the store saved-accounts route.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ total, offset, limit, status, deposits });
}
