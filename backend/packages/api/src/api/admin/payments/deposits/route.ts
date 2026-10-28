import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import {
  resolvePacks,
  type GatewayReports,
} from '../../../../modules/packs/facets';
import {
  GATEWAY_FULL_SWEEP_EVERY_MIN,
  GATEWAY_STALE_AFTER_MS,
} from '../../../../modules/packs/gateway-reconcile';
import {
  parsePaginationParams,
  parseSortParam,
} from '../../../../utils/pagination';
import { parseCustomerFilter } from '../customer-filter';

// GET /admin/payments/deposits — operator visibility into the gateway
// deposit table.
//
// WHY this route exists: a deposit row is the ONLY record tying a payment at the
// gateway to a customer, and until now nothing in the dashboard could read it.
// The failure this covers is a customer who paid while both the callback and the
// reconciliation sweep missed: the money is at the gateway, the row sits
// 'pending' forever, and finding it meant hand-written SQL against production.
//
// Read-only on purpose. There is no settle/requery action here: the 10-minute
// sweep (jobs/deposit-reconcile.ts) is the authoritative repair path, and a
// manual "credit this" button would be a second, unaudited way to mint credit.
//
// Admin-only (auto-protected /admin/* route), so joining the customer email is
// legitimate operator visibility — the same call the Pull Ledger makes.

// 'all' is a view, not a stored status: it drops the status filter entirely.
// 'expired' IS a stored status — the sweep writes it when it stopped chasing a
// deposit the gateway never ruled on. It needs its own view precisely because
// this page exists to answer "did somebody pay and not get credit?", and an
// expired row is the strongest candidate for a yes.
const STATUS_FILTERS = [
  'pending',
  'settled',
  'failed',
  'expired',
  'all',
] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

/** Unknown/absent status falls back to 'pending' — the view that matters. */
export function parseStatusFilter(raw: unknown): StatusFilter {
  return typeof raw === 'string' &&
    (STATUS_FILTERS as readonly string[]).includes(raw)
    ? (raw as StatusFilter)
    : 'pending';
}

// Sortable columns are an allowlist, not a passthrough — `order` goes straight
// into the query builder. Real columns only: customer_email and stale are
// computed in JS after the page is fetched. The two money columns are
// `bigNumber` fields, which store a numeric column plus a raw_* jsonb sidecar;
// ordering targets the numeric column (proved against a real database in
// integration-tests/http/gateway-reconcile.spec.ts, not just a mock).
const SORTABLE = new Set(['created_at', 'amount_requested', 'amount_settled']);

// A pending row the sweep should long since have closed. An abandoned cashier
// requeries as non-final and expires on the first full sweep past the stale
// window, so `stale` alone mostly flags customers who walked away (the noise
// operators asked to stop seeing, 2026-10-25). Two full sweeps later, a row
// that still has the gateway's id (the customer DID get a cashier) is stuck on
// our side or theirs — quarantined, an unanswerable requery, an unknown state —
// and may be a payment nobody credited. Rows without a gateway id never
// reached a cashier, so they cannot be paid and are never stuck.
const STUCK_AFTER_MS =
  GATEWAY_STALE_AFTER_MS + 2 * GATEWAY_FULL_SWEEP_EVERY_MIN * 60 * 1000;

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = resolvePacks<GatewayReports>(req.scope);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );
  const status = parseStatusFilter(req.query.status);
  const customer = parseCustomerFilter(req.query.customer_id);
  if (customer === 'invalid') {
    res.status(400).json({ message: 'customer_id must be a customer id.' });
    return;
  }

  // Pending sorts OLDEST first (the ['status','created_at'] index): the row most
  // likely to be a stranded payment is the one that has been waiting longest, so
  // it belongs at the top rather than buried on the last page. Every other view
  // is a history read, where newest-first is what an operator expects. That
  // status-dependent default only holds while the operator has NOT picked a
  // sort — an explicit `?sort=` overrides it.
  //
  // `id` is the tiebreaker on BOTH paths, not just the sorted one: offset
  // pagination needs a unique secondary key, and two deposits written in the
  // same tick share a created_at often enough that a row can otherwise land on
  // two pages or on neither. It cannot reorder rows with distinct created_at,
  // so the default view's meaning is unchanged.
  //
  // The status-dependent direction is passed as the parser's FALLBACK, which is
  // what makes it survive an unhonoured `?sort=` as well as an absent one:
  // degrading a bad key to a hardcoded DESC would silently flip the pending
  // view out of oldest-first, the one ordering this endpoint exists to give.
  const defaultDir = status === 'pending' ? 'ASC' : 'DESC';
  const { key, dir } = parseSortParam(
    req.query.sort,
    SORTABLE,
    'created_at',
    defaultDir,
  );
  const order: Record<string, 'ASC' | 'DESC'> = { [key]: dir, id: dir };

  const [rows, total] = await packs.listAndCountGatewayDeposits(
    { ...(status === 'all' ? {} : { status }), ...customer },
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
  // dashboard and the job can never disagree about what counts as overdue.
  // `stuck` is the narrower signal the dashboard alarms on — see STUCK_AFTER_MS.
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
    // Settlement mirror (audit 2026-08-17 B1/B2): the fee-bearing net and the
    // BANK's own references — what support quotes when a customer disputes a
    // transfer. NULL means the row settled before the mirror (unknown), never
    // "no fee"/"no reference".
    net_amount:
      r.net_amount === null || r.net_amount === undefined
        ? null
        : Number(r.net_amount),
    bank_reference_no: r.bank_reference_no ?? null,
    unique_reference_no: r.unique_reference_no ?? null,
    // A regional rail's row (A3Pay: SGD): the currency the customer actually
    // paid / was paid in, and how much. Every RM figure above is the ledger's.
    currency: r.currency ?? 'MYR',
    gateway_amount:
      r.gateway_amount === null || r.gateway_amount === undefined
        ? null
        : Number(r.gateway_amount),
    payment_method_code: r.payment_method_code,
    status: r.status,
    gateway_status: r.gateway_status,
    created_at: r.created_at,
    settled_at: r.settled_at,
    stale:
      r.status === 'pending' &&
      now - new Date(r.created_at).getTime() > GATEWAY_STALE_AFTER_MS,
    stuck:
      r.status === 'pending' &&
      !!r.gateway_transaction_id &&
      now - new Date(r.created_at).getTime() > STUCK_AFTER_MS,
  }));

  // Identity-varying response carrying emails
  // (CWE-524): a cached copy could outlive the admin session in a shared
  // browser profile. Same rule as the store saved-accounts route.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ total, offset, limit, status, deposits });
}
