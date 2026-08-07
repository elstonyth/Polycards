import { createHash } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import {
  globepayConfigFromEnv,
  submitWithdrawal,
  GlobePayError,
} from './globepay-client';
import { newMerchantTransactionId } from './globepay-deposit';
import { withdrawalGateError } from './withdrawable';

// The submit half of the GlobePay365 payout loop (method WD), the inverse of
// globepay-deposit.ts with the money ordering flipped:
//
//   write the pending row -> DEBIT the ledger (atomic, floor 0) ->
//   SubmitWithdrawal. A DEFINITE gateway refusal refunds the debit
//   immediately; an AMBIGUOUS submit error (timeout, reset — the payout may
//   still execute) leaves the row pending for the sweep to resolve.
//
// The debit-before-submit ordering is the security property: real money must
// never be queued to leave the merchant balance while the customer's site
// balance still shows it. The refund path shares the row's idempotency
// anchor, so a crash between debit and refund is recoverable by the
// reconcile sweep, never a double refund.

/**
 * Per-transaction payout band, confirmed by the provider 2026-07-29 (Sean):
 * MYR Payout is RM 50 – RM 50,000, a DIFFERENT band from deposits (RM 30 –
 * 10,000) — the floor is higher and the ceiling is five times larger. They also
 * noted that anything above RM 10,000 is settled as several bank slips on their
 * side; that is their internal batching, invisible to us, and it does not change
 * what we submit or what a callback reports.
 *
 * Their own rejection names no numbers, so we say them.
 */
export const GLOBEPAY_WD_MIN_RM = 50;
export const GLOBEPAY_WD_MAX_RM = 50000;

/**
 * Withdrawals get their OWN switch on top of globepayEnabled(): deposits can
 * (and did) go live while payouts wait on the provider activating the WD
 * channel. Fail closed — absent config means "not open".
 */
export function globepayWithdrawalsEnabled(
  env: {
    GLOBEPAY_ENABLED?: string;
    GLOBEPAY_WITHDRAWALS_ENABLED?: string;
    GLOBEPAY_MERCHANT_CODE?: string;
  } = process.env,
): boolean {
  return (
    env.GLOBEPAY_ENABLED === 'true' &&
    env.GLOBEPAY_WITHDRAWALS_ENABLED === 'true' &&
    Boolean(env.GLOBEPAY_MERCHANT_CODE)
  );
}

/**
 * Idempotency anchor for the DEBIT row. Deterministic from (customer, our
 * reference) so a retried submit can never debit twice. Prefixed to stay
 * disjoint from every other anchor family in the ledger.
 */
export function withdrawalIdempotencyReference(
  customerId: string,
  merchantTransactionId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ customerId, merchantTransactionId }))
    .digest('hex');
  return `wd:${digest}`;
}

/**
 * Idempotency anchor for the REFUND row of a failed payout. Derived from the
 * same inputs but a different prefix: however many times a failure is
 * observed (submit error, callback status 5, requery status 5 — any mix),
 * exactly one refund is appended.
 */
export function withdrawalRefundReference(
  customerId: string,
  merchantTransactionId: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ customerId, merchantTransactionId }))
    .digest('hex');
  return `wd-refund:${digest}`;
}

/** Bank account fields, validated at the boundary. Their API gives no field
 * length errors a customer could act on, so sanity-check here. */
export function withdrawalDetailsError(input: {
  bankCode?: unknown;
  accountNumber?: unknown;
  accountHolderName?: unknown;
}): string | null {
  const bankCode = input.bankCode;
  if (typeof bankCode !== 'string' || !/^[A-Z0-9]{2,20}$/.test(bankCode)) {
    return 'Choose a bank from the list.';
  }
  const accountNumber = input.accountNumber;
  if (
    typeof accountNumber !== 'string' ||
    !/^[0-9]{6,34}$/.test(accountNumber)
  ) {
    return 'Enter a valid account number (digits only).';
  }
  const holder = input.accountHolderName;
  if (
    typeof holder !== 'string' ||
    holder.trim().length < 2 ||
    holder.trim().length > 120
  ) {
    return 'Enter the account holder name exactly as the bank has it.';
  }
  return null;
}

export type StartWithdrawalInput = {
  /** From the verified token — NEVER the request body. */
  customerId: string;
  amount: unknown;
  bankCode: unknown;
  accountNumber: unknown;
  accountHolderName: unknown;
  /** The CUSTOMER's IP (they require it), not our server's. */
  ipAddress: string;
};

export type StartWithdrawalResult = {
  merchantTransactionId: string;
  /** Their withdrawal id (W…) — null when the submit outcome is ambiguous
   * (the request may have been accepted with the response lost); the sweep
   * resolves it either way. */
  transactionId: string | null;
  amount: number;
  /** Ledger balance after the debit. */
  balance: number;
};

/**
 * Create a payout. Ordering is load-bearing:
 *   1. row (pending) — the callback needs it to find the customer
 *   2. ledger debit (atomic, floor 0, idempotent)
 *   3. SubmitWithdrawal
 * A gateway refusal refunds the debit and closes the row; a transient crash
 * after 2 leaves a pending row whose sweep resolves it (requery "not found"
 * -> refund).
 */
export async function startGlobePayWithdrawal(
  scope: { resolve: <T>(key: string) => T },
  input: StartWithdrawalInput,
  notifyUrl: string,
  verifyUrl: string,
): Promise<StartWithdrawalResult> {
  if (!globepayWithdrawalsEnabled()) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Withdrawals are not open yet.',
    );
  }

  const amount = input.amount;
  if (
    typeof amount !== 'number' ||
    !Number.isFinite(amount) ||
    amount <= 0 ||
    Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Enter a valid amount.',
    );
  }
  if (amount < GLOBEPAY_WD_MIN_RM || amount > GLOBEPAY_WD_MAX_RM) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Withdrawals must be between RM ${GLOBEPAY_WD_MIN_RM} and RM ${GLOBEPAY_WD_MAX_RM.toLocaleString('en-US')}.`,
    );
  }

  const detailsInvalid = withdrawalDetailsError(input);
  if (detailsInvalid) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, detailsInvalid);
  }
  const bankCode = input.bankCode as string;
  const accountNumber = input.accountNumber as string;
  const accountHolderName = (input.accountHolderName as string).trim();

  const config = globepayConfigFromEnv();
  const packs = scope.resolve<PacksModuleService>(PACKS_MODULE);

  // 0) PRECHECK — NOT the gate. This is an unlocked, read-only fast path whose
  // only job is to avoid writing a row for a refusal that is already certain.
  // It decides nothing: the authoritative gate is inside
  // packs.withdrawForCashout, under the per-customer `credit:` advisory lock,
  // and it re-reads this same wallet there. Deleting this block would change no
  // outcome, only leave a `failed` row behind on every rejected attempt —
  // which is the point: those rows are an operator-facing surface (the admin
  // Withdrawals page), and filling it with attempts that never moved money is
  // how an operator learns to stop reading it.
  //
  // Do NOT promote this to the decision. Two concurrent requests can both pass
  // here and only one can pass under the lock.
  const precheckError = withdrawalGateError(
    await packs.walletSummary(input.customerId),
    amount,
  );
  if (precheckError) throw precheckError;

  const merchantTransactionId = newMerchantTransactionId();

  // 1) Row first — the callback echoes MerchantTransactionId but not our
  // customer id, so this row is the only way back (same shape as deposits).
  const [row] = await packs.createGlobePayWithdrawals([
    {
      merchant_transaction_id: merchantTransactionId,
      customer_id: input.customerId,
      amount,
      bank_code: bankCode,
      account_number: accountNumber,
      account_holder_name: accountHolderName,
      status: 'pending',
    },
  ]);

  // 2) GATE + DEBIT, as one serialized transaction inside the service.
  // The withdrawal gate lives in packs.withdrawForCashout — freeze flag,
  // locked unmatured commissions, playthrough, and the rolling-24h value cap
  // — held under the per-customer `credit:` advisory lock TOGETHER with the
  // debit. It used to be checked here, before and outside any lock, which let
  // concurrent requests all read the same `withdrawable`, all pass, and all
  // debit: floor 0 (the only atomic guard) sees the RAW balance, not `locked`.
  //
  // A gate refusal that the precheck above did not already catch (a race, or a
  // balance that moved between the two reads) arrives as a throw from this call
  // and closes the row, exactly like an insufficient-balance debit always has.
  let debit;
  try {
    debit = await packs.withdrawForCashout({
      customerId: input.customerId,
      amount,
      merchantTransactionId,
      idempotencyReference: withdrawalIdempotencyReference(
        input.customerId,
        merchantTransactionId,
      ),
      bankCode,
      accountNumber,
    });
  } catch (error) {
    // Nothing was debited; the row must not sit pending or the sweep would
    // chase a withdrawal that never existed at the gateway.
    await packs.updateGlobePayWithdrawals({ id: row.id, status: 'failed' });
    throw error;
  }

  // 3) Only now is money allowed to move on their side.
  let result;
  try {
    result = await submitWithdrawal(
      {
        merchantTransactionId,
        merchantClientId: input.customerId,
        amount,
        destinationBankCode: bankCode,
        destinationAccountNumber: accountNumber,
        destinationAccountHolderName: accountHolderName,
        notifyUrl,
        returnUrl: verifyUrl,
        ipAddress: input.ipAddress,
      },
      config,
    );
  } catch (error) {
    if (error instanceof GlobePayError && error.definite) {
      // The gateway PARSEABLY refused, so no payout exists on their side.
      // Refund the debit (idempotent) and close the row.
      await packs.withdrawCreditsWithLedger({
        customerId: input.customerId,
        amount,
        reason: 'cashout',
        reference: merchantTransactionId,
        idempotencyReference: withdrawalRefundReference(
          input.customerId,
          merchantTransactionId,
        ),
        ledger: {
          outcome: 'refunded',
          bankCode: bankCode,
          accountNumber: accountNumber,
          gatewayRef: merchantTransactionId,
        },
      });
      await packs.updateGlobePayWithdrawals({ id: row.id, status: 'failed' });
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'We could not start your withdrawal. Please check the bank details and try again.',
      );
    }
    // AMBIGUOUS (timeout, reset, WAF page): the request may have been
    // accepted with only the response lost — the payout could still execute.
    // Refunding here would double-pay, so the row stays pending and the
    // reconcile sweep resolves it: requery success -> settle, failed ->
    // refund, unknown-and-stale -> refund. The customer sees the same
    // async-processing state a slow payout produces.
    scope
      .resolve<{ error: (msg: string) => void }>('logger')
      .error(
        `[globepay] withdrawal ${merchantTransactionId} submit outcome AMBIGUOUS (${(error as Error).message}) — left pending for the sweep`,
      );
    return {
      merchantTransactionId,
      transactionId: null,
      amount,
      balance: debit.balance,
    };
  }

  await packs.updateGlobePayWithdrawals({
    id: row.id,
    gateway_transaction_id: result.transactionId,
  });

  return {
    merchantTransactionId,
    transactionId: result.transactionId,
    amount,
    balance: debit.balance,
  };
}
