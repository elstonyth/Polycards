import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import {
  heldDebitGraceExpired,
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

  // AGE GATE, before the claim below. Deny closes a 'held' row the MOMENT it
  // claims it (step 1), before it knows whether a debit exists (that check is
  // step 2) — so unlike approve, this cannot live inside a "no debit found"
  // branch; it has to guard the claim itself, since the claim IS the
  // destructive step here. A held row is debited AFTER it is written 'held'
  // (step 1 vs step 2 of startGlobePayWithdrawal), so a row younger than
  // heldDebitGraceExpired's window may simply have a debit still landing, not
  // a missing one — closing it now would strand that debit with nothing left
  // to ever refund it (the sweep never selects 'held' or 'failed'). Scoped to
  // 'held' only: a 'failed' row reaching here is the recovery re-run (see
  // step 1's comment below) — its row already cleared this gate once, or was
  // closed by the request-time gate with no debit ever attempted, so neither
  // case is racing an in-flight debit.
  if (
    row.status === 'held' &&
    !heldDebitGraceExpired(new Date(row.created_at), new Date())
  ) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `Withdrawal '${row.id}' was created moments ago — its debit may still be landing. Try again in a moment.`,
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
  // written at step 1 of startGlobePayWithdrawal and debited at step 2, so
  // "no debit" here means a genuine orphan (a crash between the two steps) —
  // the AGE GATE above already turned away the other explanation (reaching
  // this point before step 2 returned) for a 'held' row. "Refunding" a
  // genuine orphan would mint credit out of nothing. The row is already
  // closed by the claim above, so there is nothing further to do for it.
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
