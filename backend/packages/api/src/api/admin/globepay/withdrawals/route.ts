import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../modules/packs/globepay-reconcile';
import { parsePaginationParams } from '../../../../utils/pagination';

// GET /admin/globepay/withdrawals — operator visibility into the GlobePay365
// payout table, the money-OUT mirror of ../deposits.
//
// WHY: a withdrawal row is the only record tying a payout at the gateway to a
// customer AND to the bank account we instructed them to pay (their callback
// echoes neither the customer nor the destination). The failure this covers is
// the inverse of the deposits page's: money already DEBITED from a customer's
// balance, payout neither confirmed nor refunded — the row sits 'pending', the
// customer is out the money, and until now finding it meant SQL against prod.
//
// Read-only on purpose, same as deposits: the withdrawal sweep
// (jobs/globepay-withdrawal-reconcile.ts) is the authoritative repair path —
// requery decides settled vs refund, and a manual "refund this" button here
// would be a second, unaudited way to mint credit.
//
// `stale` reuses the deposits' window (GLOBEPAY_STALE_AFTER_MS): the sweep has
// had the same number of chances to resolve the payout, so past it means "look
// at this row by hand" — with the extra weight that for a withdrawal a stuck
// pending row is a customer ALREADY charged.
//
// Admin-only (auto-protected /admin/* route). The destination account is shown
// in full: it exists on the row precisely so support can quote it in a payout
// dispute.

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

  // Pending oldest-first (the ['status','created_at'] index): the longest-
  // waiting payout is the likeliest stranded debit. History views newest-first.
  const [rows, total] = await packs.listAndCountGlobePayWithdrawals(
    status === 'all' ? {} : { status },
    {
      skip: offset,
      take: limit,
      order: { created_at: status === 'pending' ? 'ASC' : 'DESC' },
    },
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

  const now = Date.now();
  const withdrawals = rows.map((r) => ({
    id: r.id,
    merchant_transaction_id: r.merchant_transaction_id,
    gateway_transaction_id: r.gateway_transaction_id,
    customer_id: r.customer_id,
    customer_email: emailById.get(r.customer_id) ?? null,
    // bigNumber columns come back as strings/BigNumber — normalize for display.
    amount: Number(r.amount),
    bank_code: r.bank_code,
    account_number: r.account_number,
    account_holder_name: r.account_holder_name,
    status: r.status,
    gateway_status: r.gateway_status,
    created_at: r.created_at,
    settled_at: r.settled_at,
    stale:
      r.status === 'pending' &&
      now - new Date(r.created_at).getTime() > GLOBEPAY_STALE_AFTER_MS,
  }));

  // Identity-varying response carrying emails and full bank accounts
  // (CWE-524): a cached copy could outlive the admin session in a shared
  // browser profile. Same rule as the store saved-accounts route.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ total, offset, limit, status, withdrawals });
}
