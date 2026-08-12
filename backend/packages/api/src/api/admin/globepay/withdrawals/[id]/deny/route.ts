import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import {
  refundGlobePayWithdrawal,
  withdrawalIdempotencyReference,
} from '../../../../../../modules/packs/globepay-withdrawal';

// POST /admin/globepay/withdrawals/:id/deny — refuse a HELD payout and hand
// the money back. The other exit from 'held' (plan 094); ./approve is the
// one that pays.
//
// Deliberately NOT gated on globepayWithdrawalsEnabled(), unlike ./approve:
// approving needs the payout channel open because it calls the gateway, but
// denying only touches our own ledger. An operator must still be able to
// return a held customer's money with the channel switched off — that is
// exactly when a queue of held rows most needs clearing.
//
// Admin-only by the framework's /admin auth guard; rate-limited on the shared
// admin-action budget (src/api/middlewares.ts). Logged with the row id and
// the admin actor id, and NEVER the account number.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const logger = req.scope.resolve<{
    info: (message: string) => void;
    warn: (message: string) => void;
  }>('logger');
  const adminId = req.auth_context.actor_id;

  const [row] = await packs.listGlobePayWithdrawals(
    { id: req.params.id },
    { take: 1 },
  );
  if (!row) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Withdrawal '${req.params.id}' not found.`,
    );
  }

  // 1) CLAIM FIRST — the opposite order from the reconcile sweep, which
  // refunds and then closes the row. The inversion is deliberate:
  //
  //   - Refund-first LOSES THE APPROVE/DENY RACE. While deny is refunding,
  //     approve claims 'held' -> 'pending' and submits; deny's conditional
  //     flip then matches nothing, so the payout goes out AND the credit
  //     comes back. Real money, unrecoverable.
  //   - Claim-first's cost is the opposite window: a crash between the claim
  //     and the refund leaves a 'failed' row whose debit was never returned,
  //     and the sweep — which selects 'pending' only — will never retry it.
  //   - That window is closed by making deny RE-RUNNABLE: the claim accepts
  //     'failed' as well as 'held', and the refund is anchored on
  //     withdrawalRefundReference, which guarantees exactly one credit
  //     however many times it runs. An operator who sees a 'failed' row with
  //     no refund clicks Deny again and it settles.
  //
  // The DEBIT CHECK RIDES THE SAME CALL, and must. Deny closes the row the
  // moment it claims it, before anything has looked for a debit — so a
  // separate, later read could see "no debit" for a debit that is merely
  // still in flight (startGlobePayWithdrawal writes the row 'held' at step 1
  // and debits at step 2) and answer `refunded: false` on money that then
  // leaves the balance for good. packs.claimWithdrawalAgainstDebit does the
  // read and the claim in one transaction holding the customer's `credit:`
  // advisory lock, the same key withdrawForCashout debits under, so the two
  // cannot interleave: either the debit is already committed and we see it,
  // or our close commits first and withdrawForCashout's own re-read refuses
  // to debit a closed row. This replaced an elapsed-time gate in front of the
  // claim; see that method for why a clock could never establish this.
  //
  // A false answer means the row is in a state deny must not touch —
  // 'pending' belongs to the gateway and the sweep, 'settled' is already
  // paid. Refusing loudly is right here (unlike approve's silent no-op): the
  // operator asked to give money back and it did not happen.
  const { debited, claimed } = await packs.claimWithdrawalAgainstDebit({
    id: row.id,
    customerId: row.customer_id,
    debitReference: withdrawalIdempotencyReference(
      row.customer_id,
      row.merchant_transaction_id,
    ),
    from: ['held', 'failed'],
    to: 'failed',
  });
  if (!claimed) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Withdrawal '${row.id}' is '${row.status}' — only a held (or already-denied) withdrawal can be denied.`,
    );
  }
  // The audit line says what the claim did — not what the refund below will
  // do, which the debit-existence check may yet rule out.
  logger.info(
    `[globepay] admin ${adminId} DENIED withdrawal ${row.id} (${row.merchant_transaction_id}) — RM ${Number(row.amount)} closed`,
  );

  // 2) Only now, the money — and only if the locked read above found a debit
  // to give back. "Refunding" a row that never took the customer's money
  // would mint credit out of nothing, and because that read was taken under
  // the `credit:` lock together with the claim, `debited: false` here means
  // no debit will ever land for this row, not merely that none has yet. The
  // row is already closed by the claim, so there is nothing further to do.
  if (!debited) {
    logger.warn(
      `[globepay] closed ${row.merchant_transaction_id} without a refund — no debit ever landed for it`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({ id: row.id, status: 'failed', refunded: false });
    return;
  }

  // 3) The shared four-step ordering (refund -> receipt -> close -> notify).
  // fromStatus 'failed', because the claim above already moved the row there
  // — the helper's default 'pending' selector would silently no-op.
  // gateway_status is passed back unchanged rather than nulled: a row that
  // reached 'failed' through the sweep carries the gateway's own status
  // number, and a mistaken deny on one must not erase it.
  await refundGlobePayWithdrawal(
    req.scope,
    row,
    row.gateway_status ?? null,
    'failed',
  );

  res.setHeader('Cache-Control', 'no-store');
  res.json({ id: row.id, status: 'failed', refunded: true });
}
