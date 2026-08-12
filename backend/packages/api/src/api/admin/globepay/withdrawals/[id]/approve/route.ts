import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../../../modules/packs';
import type PacksModuleService from '../../../../../../modules/packs/service';
import {
  formatGatewayFailureReason,
  globepayWithdrawalsEnabled,
  refundGlobePayWithdrawal,
  withdrawalIdempotencyReference,
} from '../../../../../../modules/packs/globepay-withdrawal';
import {
  GlobePayError,
  globepayConfigFromEnv,
  submitWithdrawal,
} from '../../../../../../modules/packs/globepay-client';
import { payerIpOf } from '../../../../../utils/payer-ip';

// POST /admin/globepay/withdrawals/:id/approve — release a HELD payout to the
// gateway. Together with ./deny this is the only way a held row leaves that
// state (plan 094); the sweep never selects one.
//
// This resumes exactly where startGlobePayWithdrawal stopped: that function
// writes the row, debits the ledger, and returns without calling the gateway
// when the amount is above the approval threshold. Step 3 happens here.
//
// WHY submitting the ROW's stored bank details is not the forbidden precheck
// copy: globepay-withdrawal.ts's step-3 comment says money may move "only to
// the destination the LOCKED resolution returned, never to the precheck's
// copy" — and this route honours that. The row's bank_code / account_number /
// account_holder_name were written from that same locked resolution inside
// withdrawForCashout at debit time (see its step 2: the destination is
// resolved under the `credit:` advisory lock and returned to the caller), so
// the row IS the authoritative destination, not a second unlocked read. It is
// also the only one that can still be trusted now: re-resolving from the
// customer's saved accounts at approval time would let a destination edited
// AFTER the debit redirect a payout the customer already committed to.
//
// Admin-only by the framework's /admin auth guard; rate-limited on the shared
// admin-action budget (src/api/middlewares.ts). Every call is logged with the
// row id and the admin actor id, and NEVER the account number.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const logger = req.scope.resolve<{
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  }>('logger');
  const adminId = req.auth_context.actor_id;

  // EVERY precondition runs BEFORE the claim. A claim TO 'pending' followed
  // by a throw strands a row that was never submitted and hands it to the
  // sweep for no reason — the exact state the held branch exists to avoid.
  // (The undebited branch below also throws after claiming, but it claims to
  // 'failed': a closed row, which the sweep never selects.)
  if (!globepayWithdrawalsEnabled()) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'The payout channel is closed — a held withdrawal cannot be approved right now.',
    );
  }
  const notifyUrl = process.env.GLOBEPAY_WITHDRAW_NOTIFY_URL;
  const verifyUrl = process.env.GLOBEPAY_PAYOUT_VERIFY_URL;
  if (!notifyUrl || !verifyUrl) {
    // Fail closed, same reasoning as the store route: without a reachable
    // NotifyUrl a failed payout could never refund itself.
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'The payout channel is closed — a held withdrawal cannot be approved right now.',
    );
  }
  const config = globepayConfigFromEnv();

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
  const amount = Number(row.amount);

  // FREEZE, re-read at approval time. This is the ONE piece of the
  // request-time gate that must be re-checked: the whole point of a held
  // queue is that a human looks at a suspicious payout, and a freeze landing
  // between the request and the click is exactly how "suspicious" gets
  // recorded. Task 6's brief does not require the queue to surface the flag,
  // so the approver may not be able to see it — this is not something to
  // leave to the human.
  //
  // A BARE freeze read, deliberately: the rest of withdrawForCashout's gate
  // must NOT be re-run here. The debit already landed, so re-checking the
  // balance or the playthrough would judge a payout against a wallet the
  // payout itself has already reduced, and the held row already counts
  // against its own rolling-24h cap.
  //
  // Cause-agnostic (no `cause` filter), matching the request-time gate, which
  // refuses on walletSummary.isFrozen for BOTH causes. Not
  // packs.assertNotFrozen: that one is scoped to cause='manual' so a clawback
  // auto-freeze cannot block the top-up/buyback that repays it — right for an
  // inflow-repayable path, wrong here, where it would pay a real bank account
  // out of an account already in clawback debt.
  const [frozen] = await packs.listCustomerAccountStates(
    { customer_id: row.customer_id, frozen: true },
    { take: 1 },
  );
  if (frozen) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This customer’s account is frozen. Unfreeze it before approving a payout, or deny the withdrawal.',
    );
  }

  // THE DEBIT CHECK AND THE CLAIM, as ONE locked decision.
  //
  // Both halves matter. A held row is NOT always debited:
  // startGlobePayWithdrawal writes it 'held' at step 1 and debits at step 2,
  // so there is a real committed window — not only a crash — where the row is
  // visible as held with no debit yet, simply because step 2 has not
  // returned. Submitting against a debit that never lands pays a real bank
  // account out of a balance that was never reduced (a straight cash loss,
  // and a definite gateway refusal would then mint credit on top in the
  // refund branch below); closing a row whose debit is merely still in flight
  // strands that debit with nothing left to refund it.
  //
  // packs.claimWithdrawalAgainstDebit settles both under the customer's
  // `credit:` advisory lock — the same key withdrawForCashout debits under —
  // so `debited: false` means no debit will ever land, and the row move
  // commits with the reading that justified it. It replaced an elapsed-time
  // gate that inferred the same thing from the row's age; see that method for
  // why no clock can (in short: a debit blocked on the advisory lock is
  // `active`, not idle, so no Postgres timeout bounds it).
  //
  // An undebited row is closed 'failed' by that same call — scoped to 'held',
  // so an undebited row in another status (a 'pending' one is the sweep's to
  // resolve) is refused without being touched.
  const { debited, claimed } = await packs.claimWithdrawalAgainstDebit({
    id: row.id,
    customerId: row.customer_id,
    debitReference: withdrawalIdempotencyReference(
      row.customer_id,
      row.merchant_transaction_id,
    ),
    from: ['held'],
    to: 'pending',
  });
  if (!debited) {
    // The log reports what the claim did rather than asserting a close that
    // may not have landed.
    logger.warn(
      `[globepay] admin ${adminId} approve on withdrawal ${row.id} ` +
        `(${row.merchant_transaction_id}) REFUSED — no debit ever landed ` +
        `for it; ${claimed ? 'row closed' : `row left as '${row.status}'`}`,
    );
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'This withdrawal was never debited, so it cannot be paid out.',
    );
  }
  // A false claim means someone else already moved the row (a double-clicked
  // button, a racing deny): return without submitting. Idempotent, not an
  // error — the operator's intent has already happened or has already been
  // overruled, and a second payout is the one outcome that cannot be undone.
  if (!claimed) {
    logger.info(
      `[globepay] admin ${adminId} approve on withdrawal ${row.id} was a no-op — it was '${row.status}', not held`,
    );
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      id: row.id,
      status: row.status,
      transaction_id: row.gateway_transaction_id,
      approved: false,
    });
    return;
  }
  logger.info(
    `[globepay] admin ${adminId} APPROVED withdrawal ${row.id} (${row.merchant_transaction_id}) — RM ${amount} to bank ${row.bank_code}`,
  );

  let result;
  try {
    result = await submitWithdrawal(
      {
        merchantTransactionId: row.merchant_transaction_id,
        merchantClientId: row.customer_id,
        // bigNumber column — it arrives as a string, and submitWithdrawal
        // calls .toFixed(2) on it.
        amount,
        destinationBankCode: row.bank_code,
        destinationAccountNumber: row.account_number,
        destinationAccountHolderName: row.account_holder_name.trim(),
        notifyUrl,
        returnUrl: verifyUrl,
        // The ADMIN's request IP, not the customer's — that one was never
        // stored, and per src/api/utils/payer-ip.ts the store route's value is
        // already the storefront's egress IP for every customer alike ("don't
        // build anything on this being per-customer"). The field's job is to
        // be un-forgeable, which this still is.
        ipAddress: payerIpOf(req),
      },
      config,
    );
  } catch (error) {
    // Both branches mirror startGlobePayWithdrawal's post-#425 shape exactly.
    // There is no third path: an outcome that is not a PARSED refusal is
    // ambiguous, and ambiguity must never refund.
    if (error instanceof GlobePayError && error.definite) {
      // The gateway parseably refused, so no payout exists on their side.
      // Refund (idempotent, on the shared anchor) and close the row. The
      // claim above left it 'pending', which is what the helper's terminal
      // update must be scoped to — its default.
      await refundGlobePayWithdrawal(
        req.scope,
        row,
        null,
        'pending',
        // Same fields as the log line below, kept on the row because the log
        // itself does not survive the next deployment (plan 095). Built by the
        // shared formatter so this string and the store path's cannot drift —
        // and so the digit redaction, which is a control rather than
        // formatting, applies to both.
        formatGatewayFailureReason({
          prefix: 'approve refused',
          codes: error.codes,
          httpStatus: error.httpStatus,
          bankCode: row.bank_code,
          message: error.message,
        }),
      );
      // Their reason, on record, AFTER the money moved — a definitively
      // refused submit leaves nothing at the gateway to requery later, so
      // this line is the only thing that can tell an empty merchant payout
      // float (PMT10013) apart from genuinely bad bank details. Best-effort:
      // without the catch a throw from the logger would replace the error
      // below and the operator would see a crash instead of the reason.
      // Never the account number or the holder name; `msg` is the gateway's
      // own text, the one field we do not compose (same accepted residual
      // risk as the store path).
      try {
        logger.warn(
          `[globepay] admin-approved withdrawal refused: codes=${error.codes.join(',') || 'none'} ` +
            `httpStatus=${error.httpStatus} definite=${error.definite} ` +
            `bankCode=${row.bank_code} amount=${amount} ref=${row.merchant_transaction_id} ` +
            `msg=${error.message}`,
        );
      } catch {
        // Swallowed deliberately: the logger is the thing that failed, so
        // there is nothing left to report it with.
      }
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'The gateway refused this payout. The debit has been refunded and the withdrawal closed.',
      );
    }
    // AMBIGUOUS (timeout, reset, WAF page): the request may have been
    // accepted with only the response lost, so the payout could still
    // execute. Refunding would double-pay. The row stays 'pending' with NO
    // gateway id — precisely the state the reconcile sweep resolves (requery
    // success -> settle, failed -> refund, unknown-and-stale -> refund).
    //
    // WHAT MAKES THAT SAFE for a row that waited: the sweep's "too old for an
    // in-flight submit" clock reads the row's updated_at, not its created_at,
    // precisely so an approval restarts it (the claim above wrote it one hop
    // ago). Left on created_at, a row approved days after the customer asked
    // would be born stale — the next sweep tick would read a not-yet-
    // propagated payout as "never existed" and refund a transfer the bank
    // then executes. See unknownWithdrawalAction and the job's call site;
    // that clock is an invariant this route depends on, not an incidental
    // column choice.
    //
    // Returns rather than throws, for the same reason the store path does: a
    // 500 here reads as "nothing happened" and invites a retry. A retry is in
    // fact harmless (the row is no longer 'held', so the claim refuses it),
    // but the honest answer is "submitted, outcome unknown" and the response
    // says exactly that with a null transaction_id.
    try {
      logger.error(
        `[globepay] admin ${adminId} approved withdrawal ${row.merchant_transaction_id} but the submit outcome is AMBIGUOUS (${(error as Error).message}) — left pending for the sweep`,
      );
    } catch {
      // Swallowed deliberately: the row stays 'pending', so the sweep still
      // resolves this payout whether or not anyone ever reads about it.
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      id: row.id,
      status: 'pending',
      transaction_id: null,
      approved: true,
    });
    return;
  }

  // Their W… id, recorded as early as it can be — it does not exist until the
  // call above returns, and this is the next statement. The gap still matters:
  // until the id lands, unknownWithdrawalAction's hasGatewayTransactionId
  // guard cannot protect this row, and only the submit clock does.
  //
  // Scoped to 'pending' like every other terminal write on this path. Without
  // the scope, a sweep that resolved this row while the submit was in flight
  // (refunded and closed it 'failed') would have a gateway id written back
  // onto it afterwards — a refunded row wearing the id of a payout, which is
  // the one shape that makes a later reader believe the money went out.
  await packs.updateGlobePayWithdrawals({
    selector: { id: row.id, status: 'pending' },
    data: { gateway_transaction_id: result.transactionId },
  });

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    id: row.id,
    status: 'pending',
    transaction_id: result.transactionId,
    approved: true,
  });
}
