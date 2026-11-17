import { resolvePacks, type GatewayWithdrawals } from './facets';
import {
  GATEWAYS,
  GatewayError,
  getWithdrawalDetail,
  submitWithdrawal,
  type GatewayConfig,
  type PaymentGateway,
} from './gateway';
import { classifyRequeryError } from './gateway-reconcile';
import { alertPayoutDisabled, alertPayoutFloatEmpty } from './ops-alert';
import type { RowFx } from './payment-fx';
import { stampPendingWithdrawal } from './withdrawal-lifecycle';
import { refundWithdrawal } from './withdrawal-refund';

// Withdrawal Submit: the one submit -> judge -> refund-or-wait path shared by
// a new Withdrawal (startWithdrawal, after its debit) and an admin-approved
// Held Withdrawal (submitHeldWithdrawal, after its claim). The row is
// 'pending' and debited when this runs. Each caller keeps its own prechecks
// and maps the answer to its own words; this path moves the money, writes the
// row, trips the breaker and tells ops.
//
// The rule that keeps it safe: only a DEFINITE refusal the gateway confirms
// may refund. Anything unclear leaves the row pending for the sweep, the side
// that cannot pay twice.

/** Why a refused payout was refunded at once. */
export type RefundReason =
  | 'payouts-off'
  | 'wallet-empty'
  | 'creates-nothing'
  | 'not-sent'
  | 'refused';

export type WithdrawalSubmitAnswer =
  /** The gateway took it: their id is on the row. */
  | { kind: 'submitted'; transactionId: string }
  /** Refused, confirmed, refunded and closed. */
  | { kind: 'refunded'; reason: RefundReason; error: GatewayError }
  /** The gateway holds it, or its answer is unclear: pending for the sweep. */
  | { kind: 'waiting'; error: unknown };

export type WithdrawalSubmitInput = {
  /** The pending, debited row. */
  row: {
    id: string;
    customer_id: string;
    merchant_transaction_id: string;
    amount: number;
    /** A reason already on the row survives the close (first writer wins). */
    failure_reason?: string | null;
  };
  gateway: PaymentGateway;
  config: GatewayConfig;
  /** The row's FX lock, for the lookup's amounts. */
  fx: RowFx;
  /** Where the money goes, chosen by the caller: a new Withdrawal passes the
   *  destination locked at debit, a held one its row's own. */
  destination: {
    bankCode: string;
    accountNumber: string;
    accountHolderName: string;
  };
  notifyUrl: string;
  verifyUrl: string;
  ipAddress: string;
  email?: string;
  /** The locked payout-currency amount; null on an RM rail. */
  gatewayAmount: number | null;
  /** Starts `failure_reason`. */
  prefix: 'submit refused' | 'approve refused';
  /** Names the caller in ops alerts. */
  via: 'customer withdrawal' | 'admin approve';
  /** The customer reads the refusal on screen: no receipt, no feed row. */
  customerOnScreen: boolean;
};

export async function withdrawalSubmit(
  scope: { resolve: <T>(key: string) => T },
  input: WithdrawalSubmitInput,
): Promise<WithdrawalSubmitAnswer> {
  const packs = resolvePacks<GatewayWithdrawals>(scope);
  const { row, destination, gateway } = input;
  const accountHolderName = destination.accountHolderName.trim();
  const reasonFields = {
    bankCode: destination.bankCode,
    // The destination we submitted: the only values their message could echo.
    accountNumber: destination.accountNumber,
    accountHolderName,
  };
  const alertDetail = {
    amount: row.amount,
    ref: row.merchant_transaction_id,
    via: input.via,
  };
  let result;
  try {
    result = await submitWithdrawal(
      {
        merchantTransactionId: row.merchant_transaction_id,
        merchantClientId: row.customer_id,
        amount: row.amount,
        destinationBankCode: destination.bankCode,
        destinationAccountNumber: destination.accountNumber,
        destinationAccountHolderName: accountHolderName,
        notifyUrl: input.notifyUrl,
        returnUrl: input.verifyUrl,
        ipAddress: input.ipAddress,
        email: input.email,
        // The quote locked when the customer asked, never today's rate.
        ...(input.gatewayAmount !== null
          ? { gatewayAmount: input.gatewayAmount }
          : {}),
      },
      input.config,
    );
  } catch (error) {
    // Only a PARSED refusal is judged. Anything else is ambiguous: the request
    // may have been accepted with only the response lost, and refunding it
    // would pay twice if the payout then executes.
    const verdict =
      error instanceof GatewayError && error.definite
        ? await judgeRefusal(error, {
            gateway,
            config: input.config,
            fx: input.fx,
            merchantTransactionId: row.merchant_transaction_id,
          })
        : null;
    if (error instanceof GatewayError && verdict?.refund) {
      // Refund on the shared anchor and close the row, the reason on the same
      // write: it is the durable half of the caller's log line, which does not
      // survive the next deployment (plan 095). The claim/debit left the row
      // 'pending', which the close is scoped to.
      await refundWithdrawal(
        scope,
        {
          id: row.id,
          customer_id: row.customer_id,
          merchant_transaction_id: row.merchant_transaction_id,
          gateway_transaction_id: null,
          amount: row.amount,
          bank_code: destination.bankCode,
          account_number: destination.accountNumber,
          failure_reason: row.failure_reason ?? null,
        },
        null,
        'pending',
        formatGatewayFailureReason({
          prefix: input.prefix,
          codes: error.codes,
          httpStatus: error.httpStatus,
          message: error.message,
          ...reasonFields,
        }),
        { customerOnScreen: input.customerOnScreen },
      );
      warnOps(scope, verdict, gateway, alertDetail);
      return { kind: 'refunded', reason: verdict.reason, error };
    }
    if (verdict && error instanceof GatewayError) {
      // Refused, but not confirmed: pending for the sweep. An empty wallet
      // still closes the gateway to the next customer.
      warnOps(scope, verdict, gateway, alertDetail);
      // Their id, when they hold it, so their callback finds the row and the
      // sweep never refunds it on a later "not found".
      const held = heldRefusalFields(verdict, error, {
        prefix: input.prefix,
        ...reasonFields,
      });
      if (held) {
        await stampPendingWithdrawal(packs, row.id, held);
      }
    }
    return { kind: 'waiting', error };
  }

  // Their id, as early as it exists. Scoped to 'pending', like the callback's
  // identical stamp: if the sweep resolved this row while the submit was in
  // flight (refunded and closed it 'failed'), an unscoped write would land a
  // gateway id on a refunded row, the one shape that makes a later reader
  // believe the money went out. A silent no-op otherwise.
  await stampPendingWithdrawal(packs, row.id, {
    gateway_transaction_id: result.transactionId,
  });
  return { kind: 'submitted', transactionId: result.transactionId };
}

/** The ambiguous log's reason: says when a refusal was not confirmed. */
export const unconfirmed = (error: unknown): string =>
  error instanceof GatewayError && error.definite
    ? `refusal not confirmed: the gateway holds this payout or could not be asked — ${error.message}`
    : (error as Error).message;

type RefusalVerdict = {
  /** The gateway holds no such payout: refund and close the row. */
  refund: boolean;
  /** What the refund was for, when it is one. */
  reason: RefundReason;
  payoutDisabled: boolean;
  floatEmpty: boolean;
  /** Close the gateway to the next customer (see floatCannotPayAnything). */
  trip: boolean;
  /** The gateway holds the payout after all: its id, for the pending row. */
  heldId: string | null;
  /** Answered "not found", but not by a refusal known to create nothing: left
   *  pending for the sweep's hour of grace, with the refusal on the row. */
  unconfirmed: boolean;
};

/** What keeps a refusal on the row. The row is scoped to 'pending', and a row
 *  with no gateway id gets this write only in the same breath as its submit,
 *  so the sweep's clock barely moves (see jobs/withdrawal-reconcile.ts). */
function heldRefusalFields(
  verdict: RefusalVerdict,
  error: GatewayError,
  input: {
    prefix: string;
    bankCode: string;
    accountNumber: string;
    accountHolderName: string;
  },
): Record<string, string> | null {
  if (!verdict.heldId && !verdict.unconfirmed) return null;
  return {
    ...(verdict.heldId ? { gateway_transaction_id: verdict.heldId } : {}),
    failure_reason: formatGatewayFailureReason({
      prefix: `${input.prefix}, ${verdict.heldId ? 'but the gateway holds it' : 'not confirmed: left for the sweep'}`,
      codes: error.codes,
      httpStatus: error.httpStatus,
      bankCode: input.bankCode,
      message: error.message,
      accountNumber: input.accountNumber,
      accountHolderName: input.accountHolderName,
    }),
  };
}

/**
 * Before a refused payout is refunded, ask the gateway whether it holds it
 * anyway. Production 2026-10-14 (PC-286fcc20…): TGPay answered a RM 512.40
 * payout with a refusal-shaped 400 yet had created it. The instant refund let
 * the customer withdraw again, and both payouts stood at TGPay. Only an
 * explicit "not found" (classifyRequeryError), or the gateway holding it as
 * failed, confirms the refusal. A payout it holds, or a lookup that itself
 * fails, leaves the row pending for the sweep: the side that cannot pay
 * twice. Measured on TGPay 2026-10-15: a really refused payout answers 404
 * "Transaction not found", so a genuine refusal still refunds at once.
 *
 * That 404 alone is not proof either: it comes back milliseconds after the
 * submit, while the sweep gives the same answer an hour of grace "for a payout
 * to become visible". So it refunds at once only behind a refusal known to
 * create nothing ('creates-nothing', or our wallet empty). Anything else
 * waits for the sweep: an hour for the customer, where a wrong refund pays
 * them twice.
 *
 * Two refusals are taken at their word. Payouts switched off ('payouts-off'):
 * The 7 Pay's exact path + 501 + text means nothing was created (#747), and
 * asking first left such a payout pending for good, since The 7 Pay's lookup
 * need not answer while its payouts are off. And 'not-sent': the adapter
 * refused before calling the provider at all.
 */
async function judgeRefusal(
  error: GatewayError,
  input: {
    gateway: PaymentGateway;
    config: GatewayConfig;
    fx: RowFx;
    merchantTransactionId: string;
  },
): Promise<RefusalVerdict> {
  const payoutDisabled = error.result === 'payouts-off';
  const floatEmpty = error.result === 'wallet-empty';
  const kind = {
    reason: refundReason(error),
    payoutDisabled,
    floatEmpty,
    // A wallet the adapter read (A3Pay) closes the gateway only when it
    // cannot pay anything; one the provider called empty outright, always.
    trip:
      payoutDisabled ||
      (floatEmpty &&
        (error.available === undefined ||
          floatCannotPayAnything(input.gateway, {
            available: error.available,
          }))),
    unconfirmed: false,
  };
  // Taken at their word, without asking: payouts switched off, and a refusal
  // raised before anything reached the provider (owner, 2026-11-16).
  if (payoutDisabled || error.result === 'not-sent') {
    return { ...kind, refund: true, heldId: null };
  }
  try {
    const detail = await getWithdrawalDetail(
      input.merchantTransactionId,
      input.config,
      input.fx,
    );
    return detail.state === 'failed'
      ? { ...kind, refund: true, heldId: null }
      : { ...kind, refund: false, heldId: detail.transactionId || null };
  } catch (lookupError) {
    const notFound = classifyRequeryError(lookupError).kind === 'not-found';
    const proven = kind.floatEmpty || error.result === 'creates-nothing';
    return {
      ...kind,
      refund: notFound && proven,
      heldId: null,
      unconfirmed: notFound && !proven,
    };
  }
}

function refundReason(error: GatewayError): RefundReason {
  switch (error.result) {
    case 'payouts-off':
    case 'wallet-empty':
    case 'creates-nothing':
    case 'not-sent':
      return error.result;
    default:
      return 'refused';
  }
}

/**
 * An empty payout wallet or payouts switched off: close the gateway to the
 * next customer and tell ops, whether or not this payout was refunded. Not
 * awaited: the answer must not wait on Telegram.
 */
function warnOps(
  scope: Parameters<typeof alertPayoutFloatEmpty>[0],
  verdict: RefusalVerdict,
  gateway: PaymentGateway,
  detail: { amount: number; ref: string; via: string },
): void {
  if (verdict.trip) {
    tripPayoutFloatBreaker(
      gateway,
      verdict.payoutDisabled ? 'payouts-off' : 'wallet-empty',
    );
  }
  const label = GATEWAYS[gateway].label;
  if (verdict.payoutDisabled) {
    void alertPayoutDisabled(scope, { ...detail, gateway: label });
  } else if (verdict.floatEmpty) {
    void alertPayoutFloatEmpty(scope, {
      ...detail,
      gateway: label,
      refunded: verdict.refund,
    });
  }
}

/**
 * After a gateway refuses a payout because OUR payout wallet is short
 * ('wallet-empty'), every payout fails until ops tops it up. For
 * this long, new withdrawals are turned away before anything is written,
 * instead of each tap costing a row, a debit, a doomed submit and a refund
 * (2026-09-29: 19 refused attempts in two hours, 9–10 per customer).
 */
export const PAYOUT_FLOAT_COOLDOWN_MS = 5 * 60_000;
// ponytail: per process, and the web service runs 2 instances, so each can
// still let one refused submit through per window. A shared Valkey key with a
// TTL is the upgrade if that ever matters. Keyed by gateway: TGPay's empty
// wallet must not hold back The 7 Pay, the gateway an operator switches to
// precisely because TGPay's wallet is empty.
const payoutFloatEmptyUntil = new Map<
  PaymentGateway,
  { until: number; why: BreakerReason }
>();

/** Why the breaker closed a gateway: the fix an admin needs differs. */
export type BreakerReason = 'wallet-empty' | 'payouts-off';

/** Test seam: module state outlives a test (one jest process, one module). */
export function resetPayoutFloatBreaker(): void {
  payoutFloatEmptyUntil.clear();
}

/** Why `gateway` is closed to new payouts right now, or null if it is open. */
export function payoutBreaker(gateway: PaymentGateway): BreakerReason | null {
  const tripped = payoutFloatEmptyUntil.get(gateway);
  return tripped && Date.now() < tripped.until ? tripped.why : null;
}

/** Close `gateway` to new payouts for PAYOUT_FLOAT_COOLDOWN_MS. */
export function tripPayoutFloatBreaker(
  gateway: PaymentGateway,
  why: BreakerReason,
): void {
  payoutFloatEmptyUntil.set(gateway, {
    until: Date.now() + PAYOUT_FLOAT_COOLDOWN_MS,
    why,
  });
}

/**
 * Trip the gateway-wide breaker only when the float cannot pay ANY payout
 * (below the gateway's own minimum). One request larger than the float is
 * refused on its own; it must not close withdrawals for every customer.
 */
export function floatCannotPayAnything(
  gateway: PaymentGateway,
  short: { available: number },
): boolean {
  return (
    short.available < (GATEWAYS[gateway].currencyLimits?.withdrawalMin ?? 0)
  );
}

/**
 * The one place a gateway refusal is turned into a `failure_reason` string
 * (plan 095). Withdrawal Submit builds it for both its callers (a new
 * Withdrawal and an admin approve), because the redaction here is a control,
 * not formatting.
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
  const redacted = redactPayoutText(
    input.message,
    input.accountNumber,
    input.accountHolderName,
  );
  return (
    `${input.prefix}: codes=${input.codes.join(',') || 'none'} ` +
    `httpStatus=${input.httpStatus} bankCode=${input.bankCode} ` +
    `msg=${redacted}`
  ).slice(0, 400);
}

/**
 * The three redaction rules above, for any gateway free text bound for
 * `failure_reason`: formatGatewayFailureReason's refusal message, and the
 * Remark an A3Pay operator types when they fail a payout by hand.
 */
export function redactPayoutText(
  message: string,
  accountNumber: string,
  accountHolderName: string,
): string {
  const escape = (raw: string) => raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let redacted = message
    // A digit, then 5+ more digits with an optional single space or hyphen
    // between each — covers grouped, hyphenated and plain account numbers.
    .replace(/\d(?:[\s-]?\d){5,}/g, '[redacted]');
  const account = accountNumber.trim();
  if (account.length >= 4) {
    redacted = redacted.replaceAll(account, '[redacted]');
  }
  const holder = accountHolderName.trim();
  if (holder.length >= 3) {
    redacted = redacted.replace(new RegExp(escape(holder), 'gi'), '[redacted]');
  }
  return redacted;
}
