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
  // A false answer means the row is in a state deny must not touch —
  // 'pending' belongs to the gateway and the sweep, 'settled' is already
  // paid. Refusing loudly is right here (unlike approve's silent no-op): the
  // operator asked to give money back and it did not happen.
  const claimed = await packs.claimGlobePayWithdrawalStatus({
    id: row.id,
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

  // 2) Only now, the money. Guard against refunding a debit that never
  // landed, the same check the sweep runs above its own call: a held row is
  // written at step 1 of startGlobePayWithdrawal and debited at step 2, so a
  // hard crash in between strands a held row with no debit, and "refunding"
  // that would mint credit out of nothing. The row is already closed by the
  // claim above, so there is nothing further to do for it.
  const [debitRow] = await packs.listCreditTransactions(
    {
      customer_id: row.customer_id,
      source_transaction_id: withdrawalIdempotencyReference(
        row.customer_id,
        row.merchant_transaction_id,
      ),
    },
    { take: 1 },
  );
  if (!debitRow) {
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
