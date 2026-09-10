import { createHash } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { resolvePacks, type GatewayWithdrawals } from './facets';
import {
  bankSupportedBy,
  resolveWithdrawalDestination,
} from './saved-accounts';
import {
  GATEWAYS,
  gatewayConfigFor,
  gatewayUrls,
  paymentGateway,
  resolveActiveGateway,
  rowGateway,
  submitWithdrawal,
  GatewayError,
  type GatewayConfig,
  type PaymentGateway,
} from './gateway';
import { contactIfNeeded } from '../../api/utils/customer-contact';
import { newMerchantTransactionId } from './gateway-deposit';
import { gatewayEnv, gatewayEnvName } from './gateway-env';
import { withdrawalGateError } from './withdrawable';
import { nonNegativeIntFromEnv } from '../../api/utils/rate-limit';
import { notifyFeed } from './notify-feed';
import { withdrawalFeedKey } from './feed-events';
import { sendWithdrawalReceipt } from './withdrawal-receipt';

// The submit half of the gateway payout loop (method WD), the inverse of
// gateway-deposit.ts with the money ordering flipped:
//
//   write the row, its status decided up front ('held' above the approval
//   threshold, 'pending' at or below it) -> DEBIT the ledger (atomic, floor
//   0) -> SubmitWithdrawal, SKIPPED entirely when the row was written
//   'held'. A DEFINITE gateway refusal refunds the debit immediately; an
//   AMBIGUOUS submit error (timeout, reset — the payout may still execute)
//   leaves the row pending for the sweep to resolve.
//
// The debit-before-submit ordering is the security property: real money must
// never be queued to leave the merchant balance while the customer's site
// balance still shows it. The refund path shares the row's idempotency
// anchor, so a crash between debit and refund is recoverable by the
// reconcile sweep, never a double refund. A 'held' row is debited exactly
// like a 'pending' one — the threshold only skips the gateway call — and it
// leaves 'held' solely through an admin approve/deny action (plan 094),
// never through this function or the reconcile sweep's PROCESSING loop
// (which selects `status: 'pending'` only, so 'held' is structurally
// invisible to it — the sweep's separate read-only staleness log over held
// rows, plan 094 follow-up, never requeries, refunds, or writes one).

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
export const GATEWAY_WD_MIN_RM = 50;
export const GATEWAY_WD_MAX_RM = 50000;

/**
 * Above this RM figure a withdrawal is HELD for admin approval instead of
 * being submitted to the gateway (plan 094) — see the 'held' status comment
 * on the GatewayWithdrawal model for what that state means and how it ends.
 *
 * Threshold semantics are exact and strictly greater-than, in integer cents:
 * RM 1,000.00 EXACTLY still auto-submits — only RM 1,000.01 and up holds.
 * That boundary is the cheapest thing here to get wrong, so it is spelled out
 * rather than left to `>` reading correctly on its own.
 *
 * Env override GATEWAY_WD_APPROVAL_ABOVE_RM, read PER CALL (the plan-066
 * convention, same as GATEWAY_WD_DAILY_MAX_RM in service.ts and the cooldown
 * in saved-accounts.ts) via nonNegativeIntFromEnv, deliberately NOT
 * positiveIntFromEnv — never latched at module load.
 *
 * This is a money CEILING, not a rate limit, so 0 must be a real, meaningful
 * value: it is the operator's stop lever during an incident ("hold every
 * payout for a human"). positiveIntFromEnv rejects 0 and falls back to the
 * default, which would route the stop lever straight back to the wide-open
 * 1000 cap with only a log line noting it was ignored — see
 * nonNegativeIntFromEnv's own doc block in rate-limit.ts for the general
 * rule this follows.
 */
export const GATEWAY_WD_APPROVAL_ABOVE_RM_DEFAULT = 1000;

/**
 * Withdrawals get their OWN switch on top of gatewayEnabled(): deposits can
 * (and did) go live while payouts wait on the provider activating the WD
 * channel. Fail closed — absent config means "not open".
 */
export function withdrawalsEnabled(
  env: Partial<NodeJS.ProcessEnv> = process.env,
  gateway: PaymentGateway = paymentGateway(env),
): boolean {
  const configured = GATEWAYS[gateway].configured(env);
  return (
    gatewayEnv('GATEWAY_ENABLED', env) === 'true' &&
    gatewayEnv('GATEWAY_WITHDRAWALS_ENABLED', env) === 'true' &&
    configured
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

/**
 * The one place a gateway refusal is turned into a `failure_reason` string
 * (plan 095). Two callers build this — the store submit path below and the
 * admin approve route — and they must not drift, because the redaction here is
 * a control, not formatting.
 *
 * WHY REDACT AT ALL, when the log line beside each call site prints the same
 * message unredacted and the row already stores the account number: because
 * the two surfaces are not equivalent. The admin Withdrawals LIST masks
 * `account_number` to `••••1234` and serves the full value only from the
 * separate ./[id]/account route, so an unredacted provider message that echoed
 * a submitted account number would put it back on the list page — undoing the
 * mask through a column nobody thinks of as PII. Logs are a different audience
 * with different access; the database column is the one that renders.
 *
 * `msg` is the gateway's own text and the only field we do not compose, so it
 * is the only one that can carry anything we did not choose. Three rules run
 * over it, and the caller must pass the destination so the last two can:
 *
 *   1. digit sequences of 6+, SEPARATOR-TOLERANT — `1234-5678-9012` and
 *      `1234 5678 9012` are the same account number as `123456789012`, and a
 *      contiguous-only rule (the first version of this) passed the formatted
 *      forms straight through;
 *   2. the exact account number we submitted, for the short accounts rule 1
 *      cannot reach;
 *   3. the holder name we submitted, which carries no digits at all and so was
 *      wholly invisible to a digit rule — `AHMAD BIN ALI` is PII in a way
 *      `PMT10021` is not.
 *
 * The words around the redactions — where the diagnosis lives — survive.
 */
export function formatGatewayFailureReason(input: {
  prefix: string;
  codes: readonly string[];
  httpStatus: number;
  bankCode: string;
  message: string;
  /** The destination we submitted, so its own value can be redacted out of
   *  their echo of it. Both callers hold it at the point they build this. */
  accountNumber: string;
  accountHolderName: string;
}): string {
  const escape = (raw: string) => raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let redacted = input.message
    // A digit, then 5+ more digits with an optional single space or hyphen
    // between each — covers grouped, hyphenated and plain account numbers.
    .replace(/\d(?:[\s-]?\d){5,}/g, '[redacted]');
  const account = input.accountNumber.trim();
  if (account.length >= 4) {
    redacted = redacted.replaceAll(account, '[redacted]');
  }
  const holder = input.accountHolderName.trim();
  if (holder.length >= 3) {
    redacted = redacted.replace(new RegExp(escape(holder), 'gi'), '[redacted]');
  }
  return (
    `${input.prefix}: codes=${input.codes.join(',') || 'none'} ` +
    `httpStatus=${input.httpStatus} bankCode=${input.bankCode} ` +
    `msg=${redacted}`
  ).slice(0, 400);
}

export type StartWithdrawalInput = {
  /** From the verified token — NEVER the request body. */
  customerId: string;
  amount: unknown;
  /**
   * Which of the CUSTOMER's OWN saved destinations to pay. The bank code,
   * account number and holder name are resolved from that saved record, so a
   * request body can no longer name where the money goes — a stolen token
   * cannot cash out to an account the owner never registered and waited out.
   */
  accountId: unknown;
  /** The CUSTOMER's IP (they require it), not our server's. */
  ipAddress: string;
  /**
   * Optional client retry token (the Idempotency-Key header). When present, a
   * repeat of the same intent resolves to the withdrawal already created
   * instead of minting a second one.
   */
  idempotencyKey?: string;
  /** TGPay requires the recipient email on payout (needsCustomerContact). */
  email?: string;
  /** Resolved once by the route; see StartDepositInput.gateway. */
  gateway?: PaymentGateway;
};

export type StartWithdrawalResult = {
  merchantTransactionId: string;
  /** Their withdrawal id (W…) — null when the submit outcome is ambiguous
   * (the request may have been accepted with the response lost) OR the row
   * was held instead of submitted; the sweep resolves the ambiguous case
   * either way, and a held row is resolved by an admin instead. */
  transactionId: string | null;
  amount: number;
  /** Ledger balance after the debit. */
  balance: number;
  /**
   * True when this request replayed an Idempotency-Key already used: nothing
   * new was debited and no second payout was submitted. Without it a replay is
   * indistinguishable from a second successful withdrawal.
   */
  replayed?: boolean;
  /** 'held' when the amount crossed GATEWAY_WD_APPROVAL_ABOVE_RM and the row
   * was parked for admin approval instead of being submitted to the gateway;
   * 'pending' otherwise (submitted, or the submit outcome was ambiguous —
   * the sweep resolves that case, not this status). */
  status: 'pending' | 'held';
};

/**
 * Create a payout. Ordering is load-bearing:
 *   1. row — written with its FINAL status up front ('held' above the
 *      approval threshold, 'pending' at or below it; never inserted pending
 *      and then flipped) — the callback needs it to find the customer
 *   2. ledger debit (atomic, floor 0, idempotent) — unchanged by 'held': the
 *      money leaves the balance identically either way
 *   3. SubmitWithdrawal — SKIPPED for a 'held' row, which returns here
 *      instead, parked for an admin to approve or deny by hand
 * A gateway refusal refunds the debit and closes the row; a transient crash
 * after 2 leaves a pending row whose sweep resolves it (requery "not found"
 * -> refund). A held row cannot land in that crash window at all — there is
 * no step 3 to crash during.
 */
// Postgres 23505. Matched on the driver's code first and the message only as a
// fallback, because Mikro-ORM wraps the pg error and not every layer preserves
// `code` on the outermost object.
function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as { code?: unknown; message?: unknown };
  if (String(e.code) === '23505') return true;
  const nested = (error as { cause?: { code?: unknown } }).cause;
  if (nested && String(nested.code) === '23505') return true;
  return /duplicate key value|unique constraint/i.test(String(e.message ?? ''));
}

export async function startWithdrawal(
  scope: { resolve: <T>(key: string) => T },
  input: StartWithdrawalInput,
  notifyUrl: string,
  verifyUrl: string,
): Promise<StartWithdrawalResult> {
  const gateway = input.gateway ?? paymentGateway();
  if (!withdrawalsEnabled(process.env, gateway)) {
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
  const { withdrawalMin, withdrawalMax } = GATEWAYS[gateway].limits;
  if (amount < withdrawalMin || amount > withdrawalMax) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Withdrawals must be between RM ${withdrawalMin} and RM ${withdrawalMax.toLocaleString('en-US')}.`,
    );
  }

  // Empty/whitespace is treated as absent so a client sending the header
  // blank does not create a single shared key across every withdrawal.
  const idempotencyKey =
    typeof input.idempotencyKey === 'string' && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim()
      : undefined;

  const config = gatewayConfigFor(gateway);
  const packs = resolvePacks<GatewayWithdrawals>(scope);

  // Scoped OFF 'failed' on purpose, matching the partial unique index. A failed
  // attempt never moved money and its cause is usually the customer's to fix —
  // insufficient balance, playthrough not met, the daily cap — so replaying it
  // would report a payout that is never coming, and refusing the key would
  // dead-end a customer following the house convention of one key per INTENT,
  // reused across error retries (TopUpSheet.tsx). Excluding it from both the
  // read and the index makes such a retry a plain fresh attempt.
  //
  // Stated as "everything EXCEPT failed", never as a list of live statuses. The
  // index predicate is `status <> 'failed'`, and a read that enumerates instead
  // silently stops matching the moment a status is added: plan 094's 'held'
  // would have fallen straight through an allowlist, so retrying a withdrawal
  // parked for admin approval — every payout over RM 1,000 — would have minted
  // a SECOND one. Read and index must express the same predicate.
  const replayExisting = async (): Promise<StartWithdrawalResult | null> => {
    if (!idempotencyKey) return null;
    const [prior] = await packs.listGatewayWithdrawals(
      {
        customer_id: input.customerId,
        idempotency_key: idempotencyKey,
        status: { $ne: 'failed' },
      },
      { take: 1 },
    );
    if (!prior) return null;
    return {
      merchantTransactionId: prior.merchant_transaction_id,
      transactionId: prior.gateway_transaction_id ?? null,
      amount: Number(prior.amount),
      balance: await packs.creditBalance(input.customerId),
      replayed: true,
      // Echo the ORIGINAL row's disposition: a replay of a held withdrawal must
      // still tell the client it is awaiting approval, not that it is pending.
      status: prior.status === 'held' ? 'held' : 'pending',
    };
  };

  // 0) REPLAY FIRST, ahead of both prechecks. A replay reports an outcome that
  // already happened, so it must not be re-judged against state that has moved
  // since: deleting the saved account, or spending the balance down, would
  // otherwise turn the retry of an in-flight withdrawal into a 400 and hide a
  // payout the customer already has. The prechecks below exist to avoid writing
  // a row for a refusal that is certain — a replay writes no row at all.
  const replayedEarly = await replayExisting();
  if (replayedEarly) return replayedEarly;

  // 0a) DESTINATION PRECHECK — NOT the gate, exactly like the wallet precheck
  // below. The authoritative resolution happens inside packs.withdrawForCashout
  // under the `credit:` advisory lock, and its result is what the gateway is
  // told to pay. This copy exists so a refusal that is already certain (no such
  // saved account, still cooling off) does not leave a `failed` row on the
  // operator-facing Withdrawals page, and so the row we are about to write can
  // carry the destination at all.
  //
  // It cannot approve anything the locked resolution would refuse: both read the
  // same list, and savedBankAccountId is derived from (bankCode, accountNumber),
  // so an id resolves to the same destination in both reads or to nothing.
  const precheckDestination = resolveWithdrawalDestination({
    accounts: await packs.savedBankAccountsFor(input.customerId),
    accountId: input.accountId,
  });

  // Belt and braces on the STORED values. The saved-accounts route applies this
  // same check on save, so a stored account that fails here predates that route
  // or was written around it — either way the gateway must not see it.
  const detailsInvalid = withdrawalDetailsError(precheckDestination);
  if (detailsInvalid) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, detailsInvalid);
  }
  // A bank the active gateway cannot pay to is refused HERE, before any
  // debit, with the reason. The adapter would refuse it too, but only after
  // the row and the debit exist — a refund, a failed row on the admin queue
  // and a "check your details" email for something that is not the
  // customer's mistake. Saved accounts survive a switch; this is the one
  // moment they are not payable.
  if (!bankSupportedBy(precheckDestination.bankCode, gateway)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This bank account is not available with the current payout provider. Pick another saved account, or try again later.',
    );
  }
  // Same rule for the recipient email a TGPay payout needs: the adapter
  // would refuse a blank one as a definite error, but only after the row and
  // the debit exist — a refund and a failed row for something the customer
  // fixes in Account settings.
  if (GATEWAYS[gateway].needsCustomerContact && !input.email) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Add an email address to your account before withdrawing.',
    );
  }

  // 0b) PRECHECK — NOT the gate. This is an unlocked, read-only fast path whose
  // only job is to avoid writing a row for a refusal that is already certain.
  // The authoritative gate is inside packs.withdrawForCashout, under the
  // per-customer `credit:` advisory lock, and it re-reads this same wallet
  // there. Deleting this block would leave a `failed` row behind on every
  // rejected attempt — which is the point: those rows are an operator-facing
  // surface (the admin Withdrawals page, #384), and filling it with attempts
  // that never moved money is how an operator learns to stop reading it.
  //
  // This check can only refuse EARLIER, never approve. Both reads are of the
  // same wallet, so the only divergence is the balance moving between them: if
  // it CLOSES, the locked gate still refuses (this just missed it); if it
  // OPENS, this refuses an attempt the gate would have allowed — a retryable
  // 400, not a lost payout. It can never let through something the gate would
  // reject, which is why it is not a control.
  //
  // Do NOT promote this to the decision. Two concurrent requests can both pass
  // here and only one can pass under the lock.
  const precheckError = withdrawalGateError(
    await packs.walletSummary(input.customerId),
    amount,
  );
  if (precheckError) throw precheckError;

  const merchantTransactionId = newMerchantTransactionId();

  // Approval-threshold check, read PER CALL — never latched at module load
  // (the plan-066 convention). Strictly greater-than, integer cents: RM
  // 1,000.00 exactly still auto-submits (Global Constraint 1).
  const held =
    Math.round(amount * 100) >
    nonNegativeIntFromEnv(
      gatewayEnvName('GATEWAY_WD_APPROVAL_ABOVE_RM'),
      GATEWAY_WD_APPROVAL_ABOVE_RM_DEFAULT,
    ) *
      100;

  // 1) Row first — the callback echoes MerchantTransactionId but not our
  // customer id, so this row is the only way back (same shape as deposits).
  // Written with its FINAL status: a held row is never inserted 'pending'
  // and flipped, which would otherwise leave a window where a crash strands
  // a 'pending' row with no gateway submission — the exact state the sweep
  // refunds.
  //
  // The read above turns a SEQUENTIAL retry into a clean replay; the partial
  // unique index is what makes it safe when two requests race, because both can
  // pass that read before either inserts. Losing that race is a replay, not a
  // 500: re-read under the same predicate the index enforces and return the row
  // the winner wrote. Nothing has been debited at this point either way.
  const insertRow = async () =>
    (
      await packs.createGatewayWithdrawals([
        {
          idempotency_key: idempotencyKey ?? null,
          merchant_transaction_id: merchantTransactionId,
          customer_id: input.customerId,
          amount,
          bank_code: precheckDestination.bankCode,
          account_number: precheckDestination.accountNumber,
          account_holder_name: precheckDestination.accountHolderName.trim(),
          status: held ? 'held' : 'pending',
          gateway,
        },
      ])
    )[0];

  let row: Awaited<ReturnType<typeof insertRow>>;
  try {
    row = await insertRow();
  } catch (error) {
    if (!idempotencyKey || !isDuplicateKeyError(error)) throw error;
    const raced = await replayExisting();
    if (raced) return raced;
    // The index rejected the insert but no active row is visible — the winner
    // must have failed and freed the key between the two statements. Surfacing
    // the original error beats inventing a success.
    throw error;
  }

  // 2) GATE + DEBIT, as one serialized transaction inside the service.
  // The withdrawal gate lives in packs.withdrawForCashout — freeze flag,
  // the freeze gate, playthrough, and the rolling-24h value cap
  // — held under the per-customer `credit:` advisory lock TOGETHER with the
  // debit. It used to be checked here, before and outside any lock, which let
  // concurrent requests all read the same `withdrawable`, all pass, and all
  // debit: floor 0 (the only atomic guard) sees the RAW balance, not `locked`.
  //
  // A gate refusal that the precheck above did not already catch (a race, or a
  // balance that moved between the two reads) arrives as a throw from this call
  // and closes the row, exactly like an insufficient-balance debit always has.
  // The same is true of the destination: withdrawForCashout re-resolves it under
  // the lock and a refusal there lands in this catch.
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
      accountId: input.accountId,
    });
  } catch (error) {
    // Nothing was debited; the row must not sit pending or the sweep would
    // chase a withdrawal that never existed at the gateway.
    //
    // Safe on the newest reason to land here — withdrawForCashout's step-1a
    // refusal, which fires precisely when an admin already closed this row
    // 'failed' under the `credit:` lock. This write is an unscoped
    // `status = 'failed'` by id, so re-stamping the value it already holds is
    // a no-op, and no other close state is reachable: an admin only claims
    // 'pending' when it has SEEN the debit (in which case this call did not
    // throw), and nothing has submitted to the gateway yet, so 'settled' is
    // impossible.
    await packs.updateGatewayWithdrawals({ id: row.id, status: 'failed' });
    throw error;
  }

  // HELD stops here, after the debit and before any gateway call. The row
  // already carries its terminal 'held' status from the step-1 insert — it
  // is not touched again on this path. See the model's 'held' comment for
  // how it leaves: admin approve (-> 'pending', submitted from there) or
  // admin deny (-> 'failed', refunded). Nothing consumes 'held' yet (that is
  // a later plan-094 task), so a row parked here simply waits.
  if (held) {
    return {
      merchantTransactionId,
      transactionId: null,
      amount,
      balance: debit.balance,
      status: 'held',
    };
  }

  // 3) Only now is money allowed to move on their side — and only to the
  // destination the LOCKED resolution returned, never to the precheck's copy.
  const bankCode = debit.destination.bankCode;
  const accountNumber = debit.destination.accountNumber;
  const accountHolderName = debit.destination.accountHolderName.trim();
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
        email: input.email,
      },
      config,
    );
  } catch (error) {
    if (error instanceof GatewayError && error.definite) {
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
      // The reason rides along with the close, on the SAME write: a second
      // round-trip could fail on its own and leave the row closed with nothing
      // said. `failure_reason` is the durable half of the log line below —
      // DigitalOcean run logs only cover the current deployment, so on
      // 2026-08-11 the codes for eight failed production payouts were gone by
      // the next morning while the rows themselves survived, saying only
      // 'failed'. Their codes, the HTTP status and the destination BANK CODE,
      // plus their message with digit runs redacted — see
      // formatGatewayFailureReason for why this column redacts where the log
      // beside it does not.
      await packs.updateGatewayWithdrawals({
        id: row.id,
        status: 'failed',
        failure_reason: formatGatewayFailureReason({
          prefix: 'submit refused',
          codes: error.codes,
          httpStatus: error.httpStatus,
          bankCode,
          message: error.message,
          // The destination we actually submitted — the only values their
          // message could echo back at us.
          accountNumber,
          accountHolderName,
        }),
      });
      // Log their reason before it is flattened into the customer-facing
      // message below — the sibling deposit branch has done this since
      // 2026-08-04 and this one never did, so a live payout could refuse with
      // NOTHING on record: the row stores status 'failed' with no code, and a
      // definitively-refused submit leaves no transaction at the gateway to
      // requery. The generic message that reaches the customer ("check the bank
      // details") is a guess, and an empty merchant payout float (PMT10013)
      // produces exactly the same words. This line is the only thing that can
      // tell those apart.
      //
      // AFTER the refund and the status update, mirroring the deposit branch.
      // The try/catch below already covers a logger that THROWS, so ordering is
      // no longer what protects the money path from that; what it still buys is
      // protection from a logger that HANGS — a blocked transport or a full
      // disk — which no catch can rescue. The cost is a real blind spot: if
      // `withdrawCreditsWithLedger` itself throws, the refusal never reaches the
      // logs, and a definite refusal whose refund also failed is the incident
      // you would most want a record of. Accepted, because a hung logger
      // stranding a refund is worse than a rare unlogged double failure.
      //
      // `error.message` carries the diagnosis when `codes` is empty. Safe to
      // log: their codes and message, the HTTP status, the destination BANK CODE
      // (the prime suspect when a picker offers a code their payout channel will
      // not accept), the amount and our own opaque reference. We never ADD the
      // account number or the holder name — those are the customer's PII — and
      // never the envelope, which is signed and encrypted. `msg` is the one
      // field we do not compose: it is the gateway's own text, so if they ever
      // echo a submitted account number in a validation message it lands here.
      // Internal logs and a number already in our own database, so the residual
      // risk is accepted rather than scrubbed.
      //
      // Best-effort. Without the catch, a throw from `resolve` or `warn` escapes
      // in place of the MedusaError below and the customer gets a crash instead
      // of the one sentence that tells them what to do.
      try {
        scope
          .resolve<{ warn: (message: string) => void }>('logger')
          .warn(
            `[payments] withdrawal refused: codes=${error.codes.join(',') || 'none'} ` +
              `httpStatus=${error.httpStatus} definite=${error.definite} ` +
              `bankCode=${bankCode} amount=${amount} ref=${merchantTransactionId} ` +
              `msg=${error.message}`,
          );
      } catch {
        // Swallowed deliberately: the logger is the thing that failed, so there
        // is nothing left to report it with.
      }
      // Says who refused, and does not instruct the customer to fix something
      // that may well be correct. The old wording ("check the bank details")
      // was a guess dressed as a diagnosis: on 2026-08-11 two customers retried
      // ten times against bank details that were fine — the payout channel was
      // refusing every attempt — and nobody escalated, because the message read
      // as their mistake. The refund is stated because it already happened
      // above, and it is the fact that decides whether they need support at
      // all.
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Your withdrawal was refused by the payment provider and your balance has been returned. Check your bank details are correct — if they are, contact support rather than retrying.',
      );
    }
    // AMBIGUOUS (timeout, reset, WAF page): the request may have been
    // accepted with only the response lost — the payout could still execute.
    // Refunding here would double-pay, so the row stays pending and the
    // reconcile sweep resolves it: requery success -> settle, failed ->
    // refund, unknown-and-stale -> refund. The customer sees the same
    // async-processing state a slow payout produces.
    //
    // Guarded for the same reason as the branch above, and the stakes here are
    // higher. This branch must RETURN a pending result; a throw from the logger
    // turns it into a 500, so the customer sees a failure while their balance is
    // already gone and the payout may be in flight. The natural response to that
    // is to retry — which debits again and submits a SECOND payout. Both then
    // execute: the ledger stays consistent and the merchant loses nothing, but
    // the customer asked for one withdrawal and two left the account.
    try {
      scope
        .resolve<{ error: (msg: string) => void }>('logger')
        .error(
          `[payments] withdrawal ${merchantTransactionId} submit outcome AMBIGUOUS (${(error as Error).message}) — left pending for the sweep`,
        );
    } catch {
      // Swallowed deliberately: the logger is the thing that failed. The row
      // stays 'pending', so the reconcile sweep still resolves this payout
      // whether or not anyone ever reads about it.
    }
    return {
      merchantTransactionId,
      transactionId: null,
      amount,
      balance: debit.balance,
      // Reached only on the non-held branch — a held row already returned
      // above, before this submit was ever attempted.
      status: 'pending',
    };
  }

  // Scoped to 'pending', matching the identical stamp in the callback route
  // (api/hooks/tgpay/withdrawal/route.ts) and the admin approve route's
  // own terminal write for this same field: if the sweep resolved this row
  // while the submit above was still in flight (refunded and closed it
  // 'failed'), an unscoped write would land a gateway id onto a refunded row
  // afterwards — the one shape that makes a later reader believe the money
  // went out. A silent no-op otherwise.
  await packs.updateGatewayWithdrawals({
    selector: { id: row.id, status: 'pending' },
    data: { gateway_transaction_id: result.transactionId },
  });

  return {
    merchantTransactionId,
    transactionId: result.transactionId,
    amount,
    balance: debit.balance,
    status: 'pending',
  };
}

/**
 * Refund and close a withdrawal row that will never reach the bank: the
 * reconcile sweep's stale/failed rows, and the admin deny route's denied
 * rows (plan 094 Task 5). Extracted here, the module that already owns the
 * refund's idempotency anchor, so those two paths share ONE copy of this
 * four-step money ordering instead of a second verbatim one that a bug fix
 * could land in without the other ever finding out. The payout callback
 * (api/hooks/tgpay/withdrawal/route.ts) is the third caller; its settle half
 * is applyWithdrawalOutcome below, the mirror of this function.
 *
 * The caller owns two preconditions this function does not re-check:
 *   - a debit actually exists for `withdrawal` — both callers verify this
 *     themselves before calling in (see the guard above each call site). A
 *     held row is NOT exempt: the row is written 'held' at step 1 and
 *     debited at step 2, so "no debit" can mean a genuinely stranded row (a
 *     crash between the two steps) or nothing worse than reaching the guard
 *     before step 2 returned — refunding either mints money if acted on too
 *     soon. The admin routes get that distinction from
 *     packs.claimWithdrawalAgainstDebit, which reads the debit and claims the
 *     row in one transaction holding the customer's `credit:` advisory lock,
 *     so its `debited: false` means no debit will EVER land (see that
 *     method). The sweep's own call site keeps its UNLOCKED read. Not
 *     because a 'pending' row is past its debit — it is not; a
 *     below-threshold row is written 'pending' at step 1 and debited at
 *     step 2, the same two-step shape as a held one — but because of two
 *     other things. First, unknownWithdrawalAction cannot return 'refund'
 *     until the row's updated_at is older than GATEWAY_STALE_AFTER_MS (1h),
 *     so the sweep's destructive branch is unreachable inside the debit
 *     window. Second, if it ever did close a row whose debit was queued
 *     behind the `credit:` lock, withdrawForCashout's step-1a re-read now
 *     refuses to debit a closed row. Narrowed, not closed: routing the
 *     sweep through claimWithdrawalAgainstDebit with from:['pending'] is
 *     the remaining piece, tracked separately;
 *   - the row is still in `fromStatus` — the terminal update below is scoped
 *     to it and is a SILENT NO-OP otherwise, which would leave a committed
 *     refund on a row that never closes. The sweep acts on rows it selected
 *     as 'pending' (the default); the deny route claims 'failed' before
 *     calling in and passes that. Pass the status the row is ACTUALLY in at
 *     call time, not the one it started in.
 */
export async function refundWithdrawal(
  scope: { resolve: <T>(key: string) => T },
  withdrawal: {
    id: string;
    customer_id: string;
    merchant_transaction_id: string;
    gateway_transaction_id: string | null;
    amount: unknown;
    bank_code: string;
    account_number: string;
    /** The reason already on the row, if any — a row closed by the gateway
     *  or the sweep keeps it (see the terminal update below). */
    failure_reason?: string | null;
  },
  gatewayStatus: number | null,
  fromStatus: 'pending' | 'held' | 'failed' = 'pending',
  /**
   * Why this payout is being closed, stored on the row (plan 095). REQUIRED,
   * though the three callers know three different things: the admin deny route
   * knows a human said no, the sweep knows what a requery answered, and the
   * approve route knows the gateway's own codes. It was briefly optional, which
   * bought an untested "omitted leaves the column alone" branch that no caller
   * used — a closing writer with nothing to say about why is the state this
   * whole change exists to abolish, so the type refuses it.
   */
  failureReason: string,
): ReturnType<GatewayWithdrawals['withdrawCreditsWithLedger']> {
  const packs = resolvePacks<GatewayWithdrawals>(scope);
  const refund = await packs.withdrawCreditsWithLedger({
    customerId: withdrawal.customer_id,
    amount: Number(withdrawal.amount),
    reason: 'cashout',
    reference:
      withdrawal.gateway_transaction_id ?? withdrawal.merchant_transaction_id,
    idempotencyReference: withdrawalRefundReference(
      withdrawal.customer_id,
      withdrawal.merchant_transaction_id,
    ),
    ledger: {
      outcome: 'refunded',
      bankCode: withdrawal.bank_code,
      accountNumber: withdrawal.account_number,
      gatewayRef:
        withdrawal.gateway_transaction_id ?? withdrawal.merchant_transaction_id,
    },
  });
  // The emailed record — after the refund commit, BEFORE the terminal row
  // update, outside any !replayed guard: once the row leaves 'pending'
  // nothing re-runs this branch, so a crash between the update and a later
  // send would lose the email forever. A crash after this send re-runs the
  // branch next sweep (the refund replays, the notification module's unique
  // idempotency_key dedupes the email). Non-throwing.
  //
  // That "next sweep retries" recovery belongs to the sweep specifically,
  // which revisits every row this branch can reach on a fixed schedule. A
  // 'held' row is never swept (nothing lists it; see the reconcile job's
  // query and its held-row regression test), so the admin deny route does
  // NOT get that retry for free: a crash in this exact window leaves the row
  // stuck short of its terminal update with a committed refund behind it,
  // and nothing automatic re-drives it. Its re-drive is a human — deny's
  // claim accepts a 'failed' row precisely so an operator can click Deny
  // again, which replays this whole sequence (the refund on its anchor, this
  // send under the notification module's idempotency key) and finishes it.
  await sendWithdrawalReceipt(scope, {
    customerId: withdrawal.customer_id,
    amount: Number(withdrawal.amount),
    // `||`, not `??` — an empty-string gateway id must fall through to the
    // merchant reference. Same reasoning as the settle branch's identical
    // choice in withdrawal-reconcile.ts; the fuller rationale lives
    // there (it explains that call site too, so it did not move with this
    // one — extracting the code must not orphan the comment from what else
    // it covers).
    reference:
      withdrawal.gateway_transaction_id || withdrawal.merchant_transaction_id,
    merchantTransactionId: withdrawal.merchant_transaction_id,
    outcome: 'refunded',
  });
  await packs.updateGatewayWithdrawals({
    selector: { id: withdrawal.id, status: fromStatus },
    data: {
      status: 'failed',
      gateway_status: gatewayStatus,
      // First writer wins. The admin deny route is re-runnable on a 'failed'
      // row by design, so a mistaken Deny on a row the bank already refused
      // would otherwise replace the bank's diagnostic with "denied by admin"
      // — and the deploy's logs have rotated by then (review 2026-09). Same
      // stance as gateway_status, which deny passes back unchanged.
      ...(failureReason && !withdrawal.failure_reason
        ? { failure_reason: failureReason.slice(0, 400) }
        : {}),
    },
  });
  if (!refund.replayed) {
    try {
      await notifyFeed(scope, {
        receiverId: withdrawal.customer_id,
        template: 'withdrawal_refunded',
        data: {
          amount_myr: Number(withdrawal.amount),
          reference:
            withdrawal.gateway_transaction_id ??
            withdrawal.merchant_transaction_id,
        },
        idempotencyKey: withdrawalFeedKey(
          withdrawal.merchant_transaction_id,
          'refunded',
        ),
      });
    } catch {
      // Never fail a committed refund over a notification.
    }
  }
  return refund;
}

/** The columns applyWithdrawalOutcome reads. */
export type WithdrawalOutcomeRow = {
  id: string;
  customer_id: string;
  merchant_transaction_id: string;
  gateway_transaction_id: string | null;
  amount: unknown;
};

/**
 * What the caller observed about a payout that reached the bank. Everything
 * except `gatewayRef` and `settledAt` is optional and written ONLY when
 * passed: `null` is a value ("unknown" — a NULL net is never a zero fee),
 * `undefined` means "leave the column alone". The payout callback carries no
 * bank references; the requery does.
 */
export type WithdrawalSettlement = {
  /** The reference the receipt and the feed row carry. Composed by the
   *  caller — the callback holds an id the row may not carry yet, the sweep
   *  holds only the row. */
  gatewayRef: string;
  /** Their id, when this observation learned one. An empty value is ignored
   *  rather than clearing what the row already has. */
  gatewayTransactionId?: string | null;
  gatewayStatus?: number | null;
  amountSettled?: number | null;
  netAmount?: number | null;
  bankReferenceNo?: string | null;
  uniqueReferenceNo?: string | null;
  settledAt: Date;
};

/**
 * Settle and close a withdrawal row the bank actually paid — the OTHER half
 * of refundWithdrawal above, extracted here for the same reason and
 * on the same terms: the payout callback and the reconcile sweep each carried
 * a verbatim copy of this three-step ordering, so a fix to it needed two
 * edits and got one.
 *
 *   receipt -> claim the row 'pending' -> settled -> feed row (best-effort)
 *
 * NO MONEY MOVES HERE. The debit happened at submit; settling only records
 * that it reached its destination. That is why `replayed` means something
 * different from its namesake on the refund/deposit paths: there is no ledger
 * anchor to ask, so it is the ROW CLAIM's answer — `true` says another writer
 * (a callback racing the sweep) got there first and this call wrote nothing
 * but the receipt.
 *
 * The receipt goes out BEFORE the claim and outside that guard, exactly as in
 * refundWithdrawal: once the row leaves 'pending' nothing re-runs
 * this branch, so a crash between the claim and a later send loses the email
 * forever, while a crash after the send costs at most a re-send that the
 * notification module's unique idempotency_key drops.
 *
 * The claim is scoped to 'pending' — not to whatever the caller read —
 * because that is the only status a settle may start from. A row the sweep
 * refunded a moment ago must not be flipped to 'settled' by a late callback:
 * that is a report saying the bank paid a payout we handed back.
 */
export async function applyWithdrawalOutcome(
  scope: { resolve: <T>(key: string) => T },
  withdrawal: WithdrawalOutcomeRow,
  outcome: WithdrawalSettlement,
): Promise<{ replayed: boolean }> {
  const packs = resolvePacks<GatewayWithdrawals>(scope);
  const amount = Number(withdrawal.amount);
  const gatewayTransactionId = outcome.gatewayTransactionId || null;

  await sendWithdrawalReceipt(scope, {
    customerId: withdrawal.customer_id,
    amount,
    reference: outcome.gatewayRef,
    merchantTransactionId: withdrawal.merchant_transaction_id,
    outcome: 'paid',
  });

  const claimed = await packs.claimWithdrawalStatus({
    id: withdrawal.id,
    from: ['pending'],
    to: 'settled',
    set: {
      settled_at: outcome.settledAt,
      ...(gatewayTransactionId
        ? { gateway_transaction_id: gatewayTransactionId }
        : {}),
      ...(outcome.gatewayStatus !== undefined
        ? { gateway_status: outcome.gatewayStatus }
        : {}),
      ...(outcome.bankReferenceNo !== undefined
        ? { bank_reference_no: outcome.bankReferenceNo }
        : {}),
      ...(outcome.uniqueReferenceNo !== undefined
        ? { unique_reference_no: outcome.uniqueReferenceNo }
        : {}),
    },
    money: {
      ...(outcome.amountSettled !== undefined
        ? { amount_settled: outcome.amountSettled }
        : {}),
      ...(outcome.netAmount !== undefined
        ? { net_amount: outcome.netAmount }
        : {}),
    },
  });

  if (claimed) {
    try {
      await notifyFeed(scope, {
        receiverId: withdrawal.customer_id,
        template: 'withdrawal_paid',
        data: { amount_myr: amount, reference: outcome.gatewayRef },
        idempotencyKey: withdrawalFeedKey(
          withdrawal.merchant_transaction_id,
          'paid',
        ),
      });
    } catch {
      // Never fail a committed settle over a notification.
    }
  }

  return { replayed: !claimed };
}

// ---------------------------------------------------------------------------
// The ADMIN half of the held queue (plan 094). Together these two are the only
// way a 'held' row leaves that state; the reconcile sweep never selects one.
// ---------------------------------------------------------------------------

/** What the approve route answers with, verbatim. */
export type HeldWithdrawalApproval = {
  id: string;
  /** The row's status as this caller last saw it — 'pending' once claimed,
   *  and for a LOST claim the status the loser read, not a re-read. */
  status: string;
  /** Their W… id; null when the submit outcome was ambiguous or the claim
   *  was lost. */
  transaction_id: string | null;
  /** False when someone else had already moved the row (a double-clicked
   *  button, a racing deny) — a no-op, not an error. */
  approved: boolean;
};

/** What the deny route answers with, verbatim. */
export type HeldWithdrawalDenial = {
  id: string;
  status: string;
  /** False for the never-debited edge case: a held row whose debit never
   *  landed is closed WITHOUT minting a refund. */
  refunded: boolean;
};

export type HeldWithdrawalInput = {
  withdrawalId: string;
  /** The admin actor id from the verified token. Logged, never trusted. */
  adminId: string;
};

/**
 * Release a HELD payout to the gateway.
 *
 * This resumes exactly where startWithdrawal stopped: that function writes the
 * row, debits the ledger, and returns without calling the gateway when the
 * amount is above the approval threshold. Step 3 happens here.
 *
 * WHY submitting the ROW's stored bank details is not the forbidden precheck
 * copy: startWithdrawal's step-3 comment says money may move "only to the
 * destination the LOCKED resolution returned, never to the precheck's copy" —
 * and this honours that. The row's bank_code / account_number /
 * account_holder_name were written from that same locked resolution inside
 * withdrawForCashout at debit time (its step 2 resolves the destination under
 * the `credit:` advisory lock and returns it to the caller), so the row IS the
 * authoritative destination, not a second unlocked read. It is also the only
 * one that can still be trusted now: re-resolving from the customer's saved
 * accounts at approval time would let a destination edited AFTER the debit
 * redirect a payout the customer already committed to.
 *
 * Every call is logged with the row id and the admin actor id, and NEVER the
 * account number.
 */
export async function submitHeldWithdrawal(
  scope: { resolve: <T>(key: string) => T },
  input: HeldWithdrawalInput & {
    /** The ADMIN's request IP, not the customer's — that one was never
     *  stored, and per api/utils/payer-ip.ts the store route's value is
     *  already the storefront's egress IP for every customer alike. The
     *  field's job is to be un-forgeable, which this still is. */
    payerIp: string;
  },
): Promise<HeldWithdrawalApproval> {
  const packs = resolvePacks<GatewayWithdrawals>(scope);
  const logger = scope.resolve<{
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  }>('logger');
  const { adminId } = input;

  // EVERY precondition runs BEFORE the claim. A claim TO 'pending' followed
  // by a throw strands a row that was never submitted and hands it to the
  // sweep for no reason — the exact state the held branch exists to avoid.
  // (The undebited branch below also throws after claiming, but it claims to
  // 'failed': a closed row, which the sweep never selects.)
  if (!withdrawalsEnabled()) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'The payout channel is closed — a held withdrawal cannot be approved right now.',
    );
  }
  const [row] = await packs.listGatewayWithdrawals(
    { id: input.withdrawalId },
    { take: 1 },
  );
  if (!row) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Withdrawal '${input.withdrawalId}' not found.`,
    );
  }

  // A held row is paid out through the gateway it was CREATED under, which
  // may no longer be the active one. Fail closed if that gateway has since
  // been unconfigured: the row stays held for a human, nothing moves.
  await resolveActiveGateway(scope);
  const gatewayId = rowGateway(row);
  let config: GatewayConfig | null;
  try {
    config = gatewayId ? gatewayConfigFor(gatewayId) : null;
  } catch {
    config = null;
  }
  const urls = gatewayId ? gatewayUrls(gatewayId) : null;
  const notifyUrl = urls?.withdrawNotifyUrl ?? '';
  const verifyUrl = urls?.payoutVerifyUrl ?? '';
  if (
    !config ||
    !gatewayId ||
    !notifyUrl ||
    (urls?.hasPayoutVerify && !verifyUrl)
  ) {
    // Fail closed, same reasoning as the store route: without a reachable
    // NotifyUrl a failed payout could never refund itself.
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'The payout channel is closed — a held withdrawal cannot be approved right now.',
    );
  }
  const amount = Number(row.amount);

  // TGPay needs the recipient email; looked up only on a gateway that asks
  // for it (needsCustomerContact). Resolved BEFORE the claim below, like
  // every other precondition: a customer-module failure here must not strand
  // a row that was claimed to 'pending' and never submitted. A customer with
  // no email is refused for the same reason the store route refuses one
  // pre-debit.
  const email = (
    await contactIfNeeded(scope, gatewayId, row.customer_id, 'payout')
  )?.email;
  if (GATEWAYS[gatewayId].needsCustomerContact && !email) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This customer has no email address on file, which the payout provider requires.',
    );
  }

  // FREEZE, re-read at approval time. This is the ONE piece of the
  // request-time gate that must be re-checked: the whole point of a held
  // queue is that a human looks at a suspicious payout, and a freeze landing
  // between the request and the click is exactly how "suspicious" gets
  // recorded. The queue DOES surface the flag — the list route's `frozen`
  // field drives a badge on the row and disables that row's Approve button —
  // but by that same comment it is a PREVIEW read at poll time, not the gate:
  // a freeze landing in the gap between two polls still shows
  // `frozen: false` until the next refresh. This re-read is what actually
  // enforces it.
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
  // Both halves matter. A held row is NOT always debited: startWithdrawal
  // writes it 'held' at step 1 and debits at step 2, so there is a real
  // committed window — not only a crash — where the row is visible as held
  // with no debit yet, simply because step 2 has not returned. Submitting
  // against a debit that never lands pays a real bank account out of a
  // balance that was never reduced (a straight cash loss, and a definite
  // gateway refusal would then mint credit on top in the refund branch
  // below); closing a row whose debit is merely still in flight strands that
  // debit with nothing left to refund it.
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
    // The DECISION, not the outcome (plan 132). `after.status` is the status
    // the claim landed on ('pending', or 'failed' for a never-debited row —
    // claimWithdrawalAgainstDebit overwrites it); the submit below may still
    // be refused and refunded, and that outcome is on the withdrawal row
    // (`status`, `failure_reason`). Status, amount and bank code only: the
    // account number and holder name never enter an audit payload, for the
    // same reason they never enter a log line.
    audit: {
      admin_id: adminId,
      action: 'approve_withdrawal',
      before: { status: row.status },
      after: { status: 'pending', amount, bank_code: row.bank_code },
      reason: `approved held withdrawal ${row.merchant_transaction_id} (RM ${amount})`,
    },
  });
  if (!debited) {
    // The log reports what the claim did rather than asserting a close that
    // may not have landed.
    logger.warn(
      `[payments] admin ${adminId} approve on withdrawal ${row.id} ` +
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
      `[payments] admin ${adminId} approve on withdrawal ${row.id} was a no-op — it was '${row.status}', not held`,
    );
    return {
      id: row.id,
      status: row.status,
      transaction_id: row.gateway_transaction_id,
      approved: false,
    };
  }
  logger.info(
    `[payments] admin ${adminId} APPROVED withdrawal ${row.id} (${row.merchant_transaction_id}) — RM ${amount} to bank ${row.bank_code}`,
  );

  let result;
  try {
    result = await submitWithdrawal(
      {
        email,
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
        ipAddress: input.payerIp,
      },
      config,
    );
  } catch (error) {
    // Both branches mirror startWithdrawal's post-#425 shape exactly.
    // There is no third path: an outcome that is not a PARSED refusal is
    // ambiguous, and ambiguity must never refund.
    if (error instanceof GatewayError && error.definite) {
      // The gateway parseably refused, so no payout exists on their side.
      // Refund (idempotent, on the shared anchor) and close the row. The
      // claim above left it 'pending', which is what the helper's terminal
      // update must be scoped to — its default.
      await refundWithdrawal(
        scope,
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
          // The row IS the submitted destination here (see the comment above
          // the submit call), so these are the exact values their message
          // could be echoing.
          accountNumber: row.account_number,
          accountHolderName: row.account_holder_name,
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
          `[payments] admin-approved withdrawal refused: codes=${error.codes.join(',') || 'none'} ` +
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
    // that clock is an invariant this branch depends on, not an incidental
    // column choice.
    //
    // RETURNS rather than throws, for the same reason the store path does: a
    // 500 here reads as "nothing happened" and invites a retry. A retry is in
    // fact harmless (the row is no longer 'held', so the claim refuses it),
    // but the honest answer is "submitted, outcome unknown" and the response
    // says exactly that with a null transaction_id.
    try {
      logger.error(
        `[payments] admin ${adminId} approved withdrawal ${row.merchant_transaction_id} but the submit outcome is AMBIGUOUS (${(error as Error).message}) — left pending for the sweep`,
      );
    } catch {
      // Swallowed deliberately: the row stays 'pending', so the sweep still
      // resolves this payout whether or not anyone ever reads about it.
    }
    return {
      id: row.id,
      status: 'pending',
      transaction_id: null,
      approved: true,
    };
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
  await packs.updateGatewayWithdrawals({
    selector: { id: row.id, status: 'pending' },
    data: { gateway_transaction_id: result.transactionId },
  });

  return {
    id: row.id,
    status: 'pending',
    transaction_id: result.transactionId,
    approved: true,
  };
}

/**
 * Refuse a HELD payout and hand the money back. The other exit from 'held';
 * submitHeldWithdrawal is the one that pays.
 *
 * Deliberately NOT gated on withdrawalsEnabled(), unlike approve: approving
 * needs the payout channel open because it calls the gateway, but denying only
 * touches our own ledger. An operator must still be able to return a held
 * customer's money with the channel switched off — that is exactly when a
 * queue of held rows most needs clearing.
 *
 * Logged with the row id and the admin actor id, and NEVER the account number.
 */
export async function denyHeldWithdrawal(
  scope: { resolve: <T>(key: string) => T },
  input: HeldWithdrawalInput,
): Promise<HeldWithdrawalDenial> {
  const packs = resolvePacks<GatewayWithdrawals>(scope);
  const logger = scope.resolve<{
    info: (message: string) => void;
    warn: (message: string) => void;
  }>('logger');
  const { adminId } = input;

  const [row] = await packs.listGatewayWithdrawals(
    { id: input.withdrawalId },
    { take: 1 },
  );
  if (!row) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Withdrawal '${input.withdrawalId}' not found.`,
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
  // still in flight (startWithdrawal writes the row 'held' at step 1 and
  // debits at step 2) and answer `refunded: false` on money that then leaves
  // the balance for good. packs.claimWithdrawalAgainstDebit does the read and
  // the claim in one transaction holding the customer's `credit:` advisory
  // lock, the same key withdrawForCashout debits under, so the two cannot
  // interleave: either the debit is already committed and we see it, or our
  // close commits first and withdrawForCashout's own re-read refuses to debit
  // a closed row. This replaced an elapsed-time gate in front of the claim;
  // see that method for why a clock could never establish this.
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
    // The DECISION, in the claim's own transaction (plan 132). A re-run deny
    // on an already-'failed' row re-claims it and therefore writes a SECOND
    // row — that is right: it is a second decision the operator took. Status
    // and amount only; never the account number or holder name.
    audit: {
      admin_id: adminId,
      action: 'deny_withdrawal',
      before: { status: row.status },
      after: { status: 'failed', amount: Number(row.amount) },
      reason: `denied held withdrawal ${row.merchant_transaction_id} (RM ${Number(row.amount)})`,
    },
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
    `[payments] admin ${adminId} DENIED withdrawal ${row.id} (${row.merchant_transaction_id}) — RM ${Number(row.amount)} closed`,
  );

  // 2) Only now, the money — and only if the locked read above found a debit
  // to give back. "Refunding" a row that never took the customer's money
  // would mint credit out of nothing, and because that read was taken under
  // the `credit:` lock together with the claim, `debited: false` here means
  // no debit will ever land for this row, not merely that none has yet. The
  // row is already closed by the claim, so there is nothing further to do.
  if (!debited) {
    logger.warn(
      `[payments] closed ${row.merchant_transaction_id} without a refund — no debit ever landed for it`,
    );
    return { id: row.id, status: 'failed', refunded: false };
  }

  // 3) The shared four-step ordering (refund -> receipt -> close -> notify).
  // fromStatus 'failed', because the claim above already moved the row there
  // — the helper's default 'pending' selector would silently no-op.
  // gateway_status is passed back unchanged rather than nulled: a row that
  // reached 'failed' through the sweep carries the gateway's own status
  // number, and a mistaken deny on one must not erase it.
  await refundWithdrawal(
    scope,
    row,
    row.gateway_status ?? null,
    'failed',
    // Names the admin, so a denied row is never mistaken later for one the
    // gateway refused (plan 095).
    `denied by admin ${adminId}`,
  );

  return { id: row.id, status: 'failed', refunded: true };
}
