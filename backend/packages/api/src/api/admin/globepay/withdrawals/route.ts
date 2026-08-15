import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../modules/packs/globepay-reconcile';
import { WITHDRAWAL_STATUSES } from '../../../../modules/packs/models/globepay-withdrawal';
import {
  parsePaginationParams,
  parseSortParam,
} from '../../../../utils/pagination';

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
// ./[id]/approve and ./[id]/deny (plan 094) are the one exception, and they
// are one because none of that reasoning reaches them: they act only on
// `held` rows, which the gateway has never seen — there is no requery answer
// for the sweep to be authoritative about, and no in-flight payout a refund
// could double-pay. Deny does not mint credit by a second route either; it
// calls the same refundGlobePayWithdrawal helper the sweep does, on the same
// withdrawalRefundReference anchor, so however many times it runs exactly one
// credit exists. And every call carries an admin actor id into the logs,
// which is precisely what the database console this page exists to replace
// does not.
//
// `stale` reuses the deposits' window (GLOBEPAY_STALE_AFTER_MS), read off
// updated_at — the SUBMIT clock the sweep's own staleness check reads
// (unknownWithdrawalAction, plan 094) — not created_at: the sweep has had the
// same number of chances to resolve the payout since THAT moment, so past it
// means "look at this row by hand", with the extra weight that for a
// withdrawal a stuck pending row is a customer ALREADY charged. created_at
// would disagree with the sweep on any admin-approved row, which can wait
// days for a human before a submit ever happens — no `?? created_at`
// fallback, deliberately (see the job's identical choice). updated_at
// arriving on the entity is proved against a real row in
// withdrawal-claim.integration.spec.ts; this route's own list call below
// selects no narrower than that same list call.
//
// Admin-only (auto-protected /admin/* route). The destination account is
// MASKED here and revealed one row at a time by ./[id]/account: support does
// need to quote it in a payout dispute, but a list serves up to 100 rows per
// request, so serving it in bulk hands out every listed customer's bank
// details for one row's worth of need. The reveal endpoint is what keeps that
// workflow off the database console, where nothing is audited.

const STATUS_FILTERS = [...WITHDRAWAL_STATUSES, 'all'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

// Display mask for the destination account: `••••1234`.
//
// The last-4 derivation matches setPayoutDetails' audit-row helper
// (modules/packs/service.ts) rather than the ledger's bare `.slice(-4)` —
// digits only (stored numbers carry spaces and hyphens) and only when there
// are MORE than four of them, because for a <=4-digit account the "last 4"
// would be the whole number. One deliberate divergence: that helper returns
// null in the short case, while this one returns a bare `••••`, because this
// field is a display string and the SPA renders it inline.
export function maskAccountNumber(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.length > 4 ? `••••${digits.slice(-4)}` : '••••';
}

/** Unknown/absent status falls back to 'pending'. Task 6 (plan 094) made
 *  'held' the operator-facing DEFAULT VIEW, but that default lives in the
 *  admin SPA, which always sends an explicit `?status=` on every request (see
 *  getGlobePayWithdrawals) — this fallback only ever fires for a caller that
 *  omits the param entirely, and flipping it would not change what the SPA
 *  shows. Left on 'pending' so a bare request (old bookmark, script, a future
 *  caller that forgets `?status=`) still lands on "is a customer's money
 *  stuck mid-transfer", not the approval queue. */
export function parseStatusFilter(raw: unknown): StatusFilter {
  return typeof raw === 'string' &&
    (STATUS_FILTERS as readonly string[]).includes(raw)
    ? (raw as StatusFilter)
    : 'pending';
}

// Sortable columns are an allowlist, not a passthrough — `order` goes straight
// into the query builder. Real columns only: customer_email and stale are
// computed in JS after the page is fetched. Kept to exactly the two columns the
// table renders a header for — an allowlist wider than the UI is surface for
// nothing. `amount` is a `bigNumber` field; ordering targets its numeric column
// (proved against a real database, see globepay-reconcile.spec.ts).
const SORTABLE = new Set(['created_at', 'amount']);

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);
  const logger = req.scope.resolve<{ error: (message: string) => void }>(
    'logger',
  );

  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );
  const status = parseStatusFilter(req.query.status);

  // Pending AND held oldest-first (the ['status','created_at'] index covers
  // both — it is not partial): for pending, the longest-waiting payout is the
  // likeliest stranded debit; for held (Task 6, plan 094) the longest-waiting
  // row is the customer who has waited longest for a human to look at it —
  // same "oldest is the one to chase first" reasoning, added rather than
  // replaced. History views newest-first. That status-dependent default only
  // holds while the operator has NOT picked a sort — an explicit `?sort=`
  // overrides it.
  //
  // `id` tiebreaks BOTH paths and the status-dependent direction is the
  // parser's fallback, so it survives an absent OR an unhonoured `?sort=`.
  // See the deposits route for the full reasoning — these two lists stay
  // structurally identical on purpose.
  const defaultDir = status === 'pending' || status === 'held' ? 'ASC' : 'DESC';
  const { key, dir } = parseSortParam(
    req.query.sort,
    SORTABLE,
    'created_at',
    defaultDir,
  );
  const order: Record<string, 'ASC' | 'DESC'> = { [key]: dir, id: dir };

  const [rows, total] = await packs.listAndCountGlobePayWithdrawals(
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

  // Task 6 (plan 094): the admin approve route refuses a frozen customer's
  // account, so an approver who cannot see the flag clicks straight into a
  // refusal with no explanation. Batched (one call for the whole page, not
  // one per row — a 100-row page cannot afford an N+1 here) and UNFILTERED on
  // `frozen` on purpose: this is the only route that asks for more than one
  // customer's state at once, so an array customer_id combined with
  // `frozen: true` (the single-id shape ./[id]/approve uses) has never been
  // proven against the real query builder. Filtering `frozen` in JS below
  // avoids resting the whole list on that unproven combination.
  // .catch, not a try/catch around the whole handler: this lookup is a
  // PREVIEW (approve re-checks the freeze live, per the comment on `frozen`
  // below), so its failure must degrade the page to `frozen: false` for
  // every row — exactly pre-plan-094 behaviour, when this call did not exist
  // — rather than 500 the entire withdrawals list, including the `pending`
  // view operators use to find a stranded debit. This is also the only
  // caller anywhere passing an ARRAY customer_id to
  // listCustomerAccountStates, so it is the one query on this page least
  // proven against the real query builder.
  const frozenStates = customerIds.length
    ? await packs
        .listCustomerAccountStates(
          { customer_id: customerIds },
          { take: customerIds.length },
        )
        .catch((error) => {
          logger.error(
            `[globepay-admin-withdrawals] frozen-state lookup failed for ${customerIds.length} customer(s) — degrading to frozen:false for this page: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return [];
        })
    : [];
  const frozenIds = new Set(
    frozenStates.filter((s) => s.frozen).map((s) => s.customer_id),
  );

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
    // Masked in bulk, full value via ./[id]/account. The field name is kept so
    // the SPA does not break on a rename.
    account_number: maskAccountNumber(r.account_number),
    // NOT masked: operators match a payout to a dispute by holder name, and
    // masking it would push that lookup somewhere unaudited.
    account_holder_name: r.account_holder_name,
    status: r.status,
    gateway_status: r.gateway_status,
    // Plan 095. Both are operator-facing on purpose: `failure_reason` says why
    // a payout died, and `verify_outcome` says how we answered their Payout
    // Verification (active on the production merchant).
    //
    // A null verify_outcome NARROWS the search, it does not conclude it. Three
    // things produce one: their call never reached us; it reached us but was
    // refused before we could match it to a row (a decrypt or signature
    // failure knows no merchant_transaction_id, so there is nothing to stamp);
    // or the row predates this column. Only the HTTP access log separates the
    // first two, and only for the current deployment.
    failure_reason: r.failure_reason,
    verify_outcome: r.verify_outcome,
    created_at: r.created_at,
    settled_at: r.settled_at,
    stale:
      r.status === 'pending' &&
      now - new Date(r.updated_at).getTime() > GLOBEPAY_STALE_AFTER_MS,
    // Re-checked live by ./[id]/approve at click time — this is a PREVIEW for
    // the operator, not the gate. A freeze that lands in the ~60s between two
    // polls can still make the real approve refuse even though this said
    // false a moment ago.
    frozen: frozenIds.has(r.customer_id),
  }));

  // Identity-varying response carrying customer emails (CWE-524): a cached
  // copy could outlive the admin session in a shared browser profile. Same
  // rule as the store saved-accounts route. Still set explicitly even though
  // the blanket '/admin/*' matcher in middlewares.ts now covers it — this
  // route states its own requirement rather than inheriting one silently.
  res.setHeader('Cache-Control', 'no-store');
  res.json({ total, offset, limit, status, withdrawals });
}
