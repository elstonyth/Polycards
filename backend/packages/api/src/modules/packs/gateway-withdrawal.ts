import { createHash } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { resolvePacks, type GatewayWithdrawals } from './facets';
import {
  SHARED_PAYOUT_ACCOUNT_MESSAGE,
  bankSupportedBy,
  payoutAccountSharingAllowed,
  resolveWithdrawalDestination,
  sharedAccountCheckApplies,
} from './saved-accounts';
import { findBank, walletAddressValid } from './banks';
import {
  channelStatus,
  destinationMinRm,
  isTngBank,
  tngPausedMessage,
  withdrawalsClosedMessage,
} from './withdrawal-controls';
import {
  GATEWAYS,
  gatewayConfigFor,
  gatewayUrls,
  paymentGateway,
  resolveActiveGateway,
  rowGateway,
  submitWithdrawal,
  getWithdrawalDetail,
  GatewayError,
  TGPAY_PAYOUT_DISABLED,
  GATEWAY_IDS,
  isLedgerGateway,
  TGPAY_PAYOUT_FLOAT_EMPTY,
  checkBalance,
  type GatewayConfig,
  type PaymentGateway,
} from './gateway';
import {
  loadPaymentFxQuote,
  payoutForWithdrawal,
  rowFx,
  type RowFx,
} from './payment-fx';
import { classifyRequeryError } from './gateway-reconcile';
import { A3PAY_PAYOUT_FLOAT_EMPTY } from './a3pay-client';
import {
  alertOps,
  alertPayoutDisabled,
  alertPayoutFloatEmpty,
} from './ops-alert';
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
 * Payout bands are per gateway — `GATEWAYS[id].limits.withdrawalMin/Max`
 * (`gateway.ts`), enforced in `startWithdrawal`. `GATEWAY_WD_MIN_RM` stays
 * exported only because `gateway-withdrawal.unit.spec.ts` still imports it
 * as a fixture value; it happens to equal the live TGPay floor (RM 50) but
 * is NOT itself read by any request-time validation — the registry is.
 * `GATEWAY_WD_MAX_RM` (formerly RM 50,000, the GlobePay-era ceiling; the
 * live TGPay ceiling is RM 30,000) had no remaining reader and was removed.
 */
export const GATEWAY_WD_MIN_RM = 50;

/**
 * After TGPay refuses a payout because OUR payout wallet is short
 * (TGPAY_PAYOUT_FLOAT_EMPTY), every payout fails until ops tops it up. For
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
const payoutFloatEmptyUntil = new Map<PaymentGateway, number>();

/** Test seam: module state outlives a test (one jest process, one module). */
export function resetPayoutFloatBreaker(): void {
  payoutFloatEmptyUntil.clear();
}

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
  now: number = Date.now(),
): boolean {
  const configured = GATEWAYS[gateway].configured(env);
  return (
    gatewayEnv('GATEWAY_ENABLED', env) === 'true' &&
    gatewayEnv('GATEWAY_WITHDRAWALS_ENABLED', env) === 'true' &&
    configured &&
    withdrawalsPausedUntil(env, now) === null
  );
}

/** Is ANY gateway open for payouts? The payout sweep's gate. */
export function anyWithdrawalsEnabled(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean {
  // The active gateway first (in specs that is the test-only fake, which
  // GATEWAY_IDS deliberately omits), then every registered one.
  return (
    withdrawalsEnabled(env) ||
    GATEWAY_IDS.some((id) => withdrawalsEnabled(env, id))
  );
}

/**
 * The regional gateways (A3Pay, SGD) open for payouts right now. They run
 * BESIDE the active RM gateway: a saved account at a bank only they can pay
 * is paid through them, at the converted amount.
 */
export function regionalPayoutGateways(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): PaymentGateway[] {
  return GATEWAY_IDS.filter(
    (id) => !isLedgerGateway(id) && withdrawalsEnabled(env, id),
  );
}

/** The refusal when a regional quote moved under the customer's form. */
export const RATE_CHANGED_MESSAGE =
  'The exchange rate just changed. Check the new amount and try again.';

/**
 * Is OUR float at a regional gateway short of `gatewayAmount`? A3Pay's
 * balance read is cheap and read-only; a failed read is NOT short (the submit
 * still decides), so a balance-endpoint outage never blocks payouts.
 */
/**
 * What a payout of `gatewayAmount` takes from OUR float: the amount PLUS the
 * gateway's own fee (percent and flat), rounded up to the cent, since an
 * amount that passed on its own could still be refused.
 */
export function payoutFloatNeeded(
  gateway: PaymentGateway,
  gatewayAmount: number,
): number {
  const { payoutFeePercent = 0, payoutFlatFee = 0 } = GATEWAYS[gateway] ?? {};
  return (
    Math.ceil(gatewayAmount * (100 + payoutFeePercent) - 1e-6) / 100 +
    payoutFlatFee
  );
}

async function regionalFloatShort(
  config: GatewayConfig,
  gatewayAmount: number,
): Promise<{ available: number; currency: string } | null> {
  const needed = payoutFloatNeeded(config.kind as PaymentGateway, gatewayAmount);
  try {
    const b = await checkBalance(config);
    const available = Number(b.availableBalance);
    return Number.isFinite(available) && available < needed
      ? { available, currency: b.currencyCode }
      : null;
  } catch {
    return null;
  }
}

/**
 * Does a payout refusal mean OUR float is short? TGPay says so with a platform
 * code. A3Pay only in its message text, which may also carry what the
 * customer typed, so its hint must be confirmed by a balance read before it
 * may count: a customer-specific refusal that happens to say "insufficient"
 * must not close payouts for everyone. `trip` follows the pre-checks' rule
 * (floatCannotPayAnything): short for THIS amount alone refuses this payout
 * without closing the gateway.
 */
async function floatEmptyRefusal(
  error: GatewayError,
  gateway: PaymentGateway,
  config: GatewayConfig,
  gatewayAmount: number | null,
): Promise<{ trip: boolean } | null> {
  if (error.has(TGPAY_PAYOUT_FLOAT_EMPTY)) return { trip: true };
  if (!error.has(A3PAY_PAYOUT_FLOAT_EMPTY) || gatewayAmount === null)
    return null;
  const short = await regionalFloatShort(config, gatewayAmount);
  return short ? { trip: floatCannotPayAnything(gateway, short) } : null;
}

/**
 * Trip the gateway-wide breaker only when the float cannot pay ANY payout
 * (below the gateway's own minimum). One request larger than the float is
 * refused on its own; it must not close withdrawals for every customer.
 */
function floatCannotPayAnything(
  gateway: PaymentGateway,
  short: { available: number },
): boolean {
  return (
    short.available < (GATEWAYS[gateway].currencyLimits?.withdrawalMin ?? 0)
  );
}

/**
 * Which gateway pays a bank: the ACTIVE RM gateway whenever it can, else an
 * open regional gateway that can, else the active one (whose own checks then
 * refuse the bank with the usual "not available" message).
 */
export function payoutGatewayFor(
  bankCode: string,
  active: PaymentGateway,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): PaymentGateway {
  if (bankSupportedBy(bankCode, active)) return active;
  return (
    regionalPayoutGateways(env).find((id) => bankSupportedBy(bankCode, id)) ??
    active
  );
}

/**
 * The currency a saved bank is paid in, whether or not its rail is open now:
 * the active gateway's when it can pay the bank, else that of a regional
 * gateway that could (open or closed). Unlike payoutGatewayFor, a closed rail
 * does not turn a Singapore bank into an RM one, so the storefront keeps it
 * under Singapore, shown as unavailable, instead of filing it under Malaysia.
 */
export function payoutCurrencyFor(
  bankCode: string,
  active: PaymentGateway,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): string {
  if (bankSupportedBy(bankCode, active, env)) return GATEWAYS[active].currency;
  // Display keeps the bank's regional currency even when its account format is unavailable.
  const regional = GATEWAY_IDS.find(
    (id) => !isLedgerGateway(id) && findBank(bankCode)?.codes[id],
  );
  return GATEWAYS[regional ?? active].currency;
}

/**
 * A timed pause for a provider outage with a known end, so nobody has to be
 * awake to reopen: GATEWAY_WITHDRAWALS_PAUSED_UNTIL is an ISO instant WITH its
 * offset (e.g. 2026-10-08T06:00:00+08:00). Before it, withdrawalsEnabled() is
 * false everywhere it gates (submit, held approval, the reconcile sweep, the
 * bank list, the storefront config); from it on, the variable is inert and
 * withdrawals reopen by themselves. Read per call, never latched.
 *
 * Returns the resume instant (ms) while paused, else null. An unparseable
 * value fails closed with no known end (Infinity), like the switches above.
 */
export function withdrawalsPausedUntil(
  env: Partial<NodeJS.ProcessEnv> = process.env,
  now: number = Date.now(),
): number | null {
  const raw = env.GATEWAY_WITHDRAWALS_PAUSED_UNTIL?.trim();
  if (!raw) return null;
  const until = Date.parse(raw);
  if (Number.isNaN(until)) return Infinity;
  return now < until ? until : null;
}

/** "Withdrawals are paused until 6:00 AM…" — Malaysia time, the only market. */
export function withdrawalsPausedMessage(until: number): string {
  if (!Number.isFinite(until))
    return 'Withdrawals are paused. Please try again later.';
  const at = new Date(until).toLocaleTimeString('en-US', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `Withdrawals are paused until ${at}. Please try again after ${at}.`;
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

/** A card-number hint, not proof: 16 digits with Visa/Mastercard prefix and Luhn. */
function looksLikeCardNumber(digits: string): boolean {
  if (!/^[0-9]{16}$/.test(digits)) return false;
  const bin = Number(digits.slice(0, 4));
  if (!/^[45]/.test(digits) && !(bin >= 2221 && bin <= 2720)) return false;
  let sum = 0;
  for (let i = 0; i < 16; i++) {
    let d = Number(digits[15 - i]);
    if (i % 2 === 1) d = d * 2 > 9 ? d * 2 - 9 : d * 2;
    sum += d;
  }
  return sum % 10 === 0;
}

/** Bank account fields, validated at the boundary. Their API gives no field
 * length errors a customer could act on, so sanity-check here. A USDT wallet
 * (banks.ts `wallet`) is an address in its chain's format and has no holder
 * name: the gateway is sent the customer id in its place. */
export function withdrawalDetailsError(input: {
  bankCode?: unknown;
  accountNumber?: unknown;
  accountHolderName?: unknown;
}): string | null {
  const bankCode = input.bankCode;
  if (typeof bankCode !== 'string' || !/^[A-Z0-9]{2,20}$/.test(bankCode)) {
    return 'Choose a bank from the list.';
  }
  const bank = findBank(bankCode);
  if (!bank) return 'Pick a bank from the list.';
  const lengths = bank.accountLengths;
  if (!lengths?.length) {
    return `Withdrawals to ${bank.name} are unavailable. Choose another bank.`;
  }
  const accountNumber = input.accountNumber;
  const wallet = findBank(bankCode)?.wallet;
  if (wallet) {
    return typeof accountNumber === 'string' &&
      walletAddressValid(wallet, accountNumber)
      ? null
      : wallet === 'tron'
        ? 'That is not a valid TRC20 (Tron) address. Copy it exactly from your wallet: it starts with T and is 34 characters long.'
        : 'That is not a valid ERC20 (Ethereum) address. Copy it exactly from your wallet: it starts with 0x, and capital letters matter.';
  }
  if (
    typeof accountNumber !== 'string' ||
    !/^[0-9]{5,34}$/.test(accountNumber)
  ) {
    return 'Enter a valid account number (digits only).';
  }
  if (
    bank.accountPattern &&
    !new RegExp(bank.accountPattern).test(accountNumber)
  ) {
    return bank.accountHint ?? 'Enter a valid account number for this bank.';
  }
  if (!lengths.includes(accountNumber.length)) {
    // Valid bank accounts can also pass Luhn; use the card hint only for a wrong length.
    if (looksLikeCardNumber(accountNumber)) {
      return "That looks like a card number. Enter your bank account number instead — it's in your banking app or on your statement, not on the card.";
    }
    return `${bank.name} account numbers are ${lengths.join(' or ')} digits. Check the number in your banking app.`;
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
  /**
   * The customer's saved accounts when the route already read them (it does,
   * to pick the gateway) — saves a second read. Precheck only: the locked
   * resolution inside withdrawForCashout always re-reads.
   */
  savedAccounts?: Awaited<
    ReturnType<GatewayWithdrawals['savedBankAccountsFor']>
  >;
  /** The payout rate (RM per unit) the customer was shown; regional only. */
  quotedRate?: number;
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
  /** Regional gateways: the payout currency and what the bank receives. */
  currency?: string;
  payAmount?: number;
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
  const pausedUntil = withdrawalsPausedUntil();
  if (pausedUntil !== null) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      withdrawalsPausedMessage(pausedUntil),
    );
  }
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
      // And the amount the bank was ACTUALLY asked to receive, as locked on
      // the row — never re-quoted at today's rate.
      ...(prior.gateway_amount != null && prior.currency
        ? {
            currency: String(prior.currency),
            payAmount: Number(prior.gateway_amount),
          }
        : {}),
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

  // The admin's Withdraw switch and its daily schedule (withdrawal-controls.ts).
  // After the replay, so the retry of an in-flight withdrawal still reports
  // it; before any row or debit, so nothing is written for a certain refusal.
  const controls = await packs.withdrawalControls();
  const withdrawStatus = channelStatus(controls.withdrawals, Date.now());
  if (!withdrawStatus.open) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      withdrawalsClosedMessage(withdrawStatus.reopens_at),
    );
  }

  // Our payout wallet was short moments ago (see PAYOUT_FLOAT_COOLDOWN_MS).
  // After the replay, so the retry of an in-flight withdrawal still reports
  // it; before any row or debit, so nothing is written for a certain refusal.
  if (Date.now() < (payoutFloatEmptyUntil.get(gateway) ?? 0)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Withdrawals are temporarily unavailable on our side — nothing was taken from your balance. Please try again in a few minutes.',
    );
  }

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
    accounts:
      input.savedAccounts ??
      (await packs.savedBankAccountsFor(input.customerId)),
    accountId: input.accountId,
  });

  // Belt and braces on the STORED values. The saved-accounts route applies this
  // same check on save, so a stored account that fails here predates that route
  // or was written around it — either way the gateway must not see it.
  const detailsInvalid = withdrawalDetailsError(precheckDestination);
  if (detailsInvalid) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, detailsInvalid);
  }
  // The admin's Touch 'n Go switch. Ahead of the bank check so the customer
  // reads "Touch 'n Go is paused", not "not available with the provider".
  if (isTngBank(precheckDestination.bankCode)) {
    const tngStatus = channelStatus(controls.tng, Date.now());
    if (!tngStatus.open) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        tngPausedMessage(tngStatus.reopens_at),
      );
    }
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
  // One bank account, one Polycards account, at payout too. The save check
  // trusts a typed holder name for numbers that were only saved, so a second
  // account can get in under a different spelling before the first is paid.
  // Here, whoever is paid first keeps the number. Refused before any row or
  // debit.
  if (
    sharedAccountCheckApplies(precheckDestination) &&
    !payoutAccountSharingAllowed(input.customerId)
  ) {
    const bankId = findBank(precheckDestination.bankCode)?.id;
    const paidElsewhere = (
      await packs.otherPayoutAccountHolders(
        input.customerId,
        precheckDestination.accountNumber,
        findBank(precheckDestination.bankCode)?.wallet !== undefined,
      )
    ).some(
      (h) => h.holder_name == null && findBank(h.bank_code)?.id === bankId,
    );
    if (paidElsewhere) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        SHARED_PAYOUT_ACCOUNT_MESSAGE,
      );
    }
  }
  // A destination with its own payout floor (Touch 'n Go: RM 100, or the
  // admin's higher minimum) is held to it here, before any row or debit — the
  // gateway refuses below its floor as a definite error, which would cost a
  // row, a debit and a refund per tap. The wording keeps the band phrase the
  // storefront passes through verbatim.
  const destinationMin = destinationMinRm(
    precheckDestination.bankCode,
    controls,
  );
  if (destinationMin !== null && amount < destinationMin) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Withdrawals must be between RM ${destinationMin} and RM ${withdrawalMax.toLocaleString('en-US')} for ${findBank(precheckDestination.bankCode)?.name ?? 'this account'}.`,
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

  // A regional gateway (A3Pay, SGD) pays in its own currency: quote the RM
  // debit into it NOW and lock the quote on the row, so an admin approving a
  // held payout later — or the sweep settling it — pays exactly what the
  // customer was shown, whatever the rate has done since. Before the row,
  // like every certain refusal.
  let fx: {
    currency: string;
    gatewayAmount: number;
    mid: number;
    markup: number;
  } | null = null;
  if (!isLedgerGateway(gateway)) {
    const { currency, currencyLimits } = GATEWAYS[gateway];
    const quote = await loadPaymentFxQuote(packs, currency);
    const gatewayAmount = payoutForWithdrawal(amount, quote);
    if (
      currencyLimits &&
      (gatewayAmount < currencyLimits.withdrawalMin ||
        gatewayAmount > currencyLimits.withdrawalMax)
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Withdrawals to this bank must come to between ${currency} ${currencyLimits.withdrawalMin} and ${currency} ${currencyLimits.withdrawalMax.toLocaleString('en-US')} (RM ${amount} is ${currency} ${gatewayAmount.toFixed(2)}).`,
      );
    }
    // The price the customer was shown, when the client sent one: refuse a
    // payout at a rate they never saw (the admin may have changed the fee
    // since the form loaded). Before any row or debit.
    if (
      input.quotedRate !== undefined &&
      Math.abs(Number(input.quotedRate) - quote.payoutRate) > 1e-9
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        RATE_CHANGED_MESSAGE,
      );
    }
    fx = {
      currency,
      gatewayAmount,
      mid: quote.mid,
      markup: quote.payoutMarkup,
    };
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

  // OUR float at a regional gateway must cover it. After the wallet
  // precheck, so only an amount this customer could really withdraw is
  // judged (and alerted on); before any row or debit, so nobody is refunded
  // for our empty wallet.
  if (fx) {
    const short = await regionalFloatShort(config, fx.gatewayAmount);
    if (short) {
      if (floatCannotPayAnything(gateway, short)) {
        payoutFloatEmptyUntil.set(
          gateway,
          Date.now() + PAYOUT_FLOAT_COOLDOWN_MS,
        );
      }
      void alertPayoutFloatEmpty(scope, {
        amount,
        ref: 'balance pre-check',
        via: 'customer withdrawal',
        gateway: GATEWAYS[gateway].label,
      });
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        'Withdrawals to this bank are temporarily unavailable on our side — nothing was taken from your balance. Your bank details are fine. Please try again later.',
      );
    }
  }

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
          ...(fx
            ? {
                currency: fx.currency,
                gateway_amount: fx.gatewayAmount,
                fx_mid: fx.mid,
                fx_markup: fx.markup,
              }
            : {}),
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
    //
    // Unless the debit DID commit and only its answer was lost (a dropped
    // connection): a 'failed' row is never refunded, so closing it would
    // strand the money. Close only once the wd: debit is known to be absent;
    // otherwise leave it pending, where the sweep's not-found path refunds a
    // real debit and closes a missing one without minting money.
    let debited: boolean | null = null;
    try {
      const [landed] = await packs.listCreditTransactions(
        {
          customer_id: input.customerId,
          source_transaction_id: withdrawalIdempotencyReference(
            input.customerId,
            merchantTransactionId,
          ),
        },
        { take: 1 },
      );
      debited = Boolean(landed);
    } catch {
      // Cannot tell: pending is the side that cannot lose money.
    }
    if (debited === false) {
      await packs.updateGatewayWithdrawals({ id: row.id, status: 'failed' });
    }
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
      ...(fx ? { currency: fx.currency, payAmount: fx.gatewayAmount } : {}),
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
        ...(fx ? { gatewayAmount: fx.gatewayAmount } : {}),
      },
      config,
    );
  } catch (error) {
    const verdict =
      error instanceof GatewayError && error.definite
        ? await judgeRefusal(error, {
            gateway,
            config,
            fx: rowFx(row),
            gatewayAmount: fx?.gatewayAmount ?? null,
            merchantTransactionId,
          })
        : null;
    if (error instanceof GatewayError && verdict?.refund) {
      // The gateway PARSEABLY refused and, asked, holds no such payout.
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
      // OUR payout wallet at TGPay is short — the customer's details are fine
      // and retrying cannot help until ops tops it up. On 2026-09-29 the copy
      // below sent one customer through nine attempts and three bank accounts
      // or name spellings. Not awaited: the answer must not wait on Telegram.
      // Payouts switched off at the gateway (TGPAY_PAYOUT_DISABLED) is the
      // same situation for the customer, so it shares the breaker and copy;
      // only the ops alert names the different fix.
      if (verdict.payoutDisabled || verdict.floatEmpty) {
        warnOps(scope, verdict, gateway, {
          amount,
          ref: merchantTransactionId,
          via: 'customer withdrawal',
        });
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          'Withdrawals are temporarily unavailable on our side and your balance has been returned. Your bank details are fine — there is no need to change them. Please try again later.',
        );
      }
      // TGPay's Touch 'n Go route refused 97 of 110 payouts in the week to
      // 2026-10-14, at any amount, with "No payout provider is available for
      // this order": their routing, not the customer's wallet. Under the
      // generic copy below, customers retried 10+ times each "checking" correct
      // details. Banks still pay, so point them there. (TNG is off unless
      // TNG_PAYOUTS_ENABLED; this matters once it is back on.) Storefront
      // passes it through on /temporarily unavailable/ (vault-errors.ts).
      if (
        findBank(bankCode)?.id === 'TNGMY' &&
        /no payout provider is available/i.test(error.message)
      ) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          "Touch 'n Go withdrawals are temporarily unavailable from our payment provider. Your balance has been returned. Please withdraw to a bank account for now.",
        );
      }
      // The same refusal for every bank: from 2026-10-20 17:40 TGPay refused
      // all bank payouts this way (67 refusals, 8+ customers). Under the
      // generic copy below customers blamed their bank details and retried 4–6
      // times. Their routing, so say the details are fine and come back later.
      // Worded to hit the storefront's existing /withdrawals are temporarily
      // unavailable/ pass-through (vault-errors.ts), so it reads right whichever
      // deploy lands first.
      if (/no payout provider is available/i.test(error.message)) {
        throw new MedusaError(
          MedusaError.Types.NOT_ALLOWED,
          'Withdrawals are temporarily unavailable from our payout partner. Your balance has been returned and your bank details are fine. Please try again later.',
        );
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
    if (verdict) {
      // Refused, but not confirmed: the row stays pending for the sweep. An
      // empty wallet still closes the gateway to the next customer.
      warnOps(scope, verdict, gateway, {
        amount,
        ref: merchantTransactionId,
        via: 'customer withdrawal',
      });
      if (verdict.heldId && error instanceof GatewayError) {
        // Their id, so their callback finds the row and the sweep never
        // refunds it on a later "not found"; scoped to 'pending' like the
        // success write below.
        await packs.updateGatewayWithdrawals({
          selector: { id: row.id, status: 'pending' },
          data: {
            gateway_transaction_id: verdict.heldId,
            failure_reason: formatGatewayFailureReason({
              prefix: 'submit refused, but the gateway holds it',
              codes: error.codes,
              httpStatus: error.httpStatus,
              bankCode,
              message: error.message,
              accountNumber,
              accountHolderName,
            }),
          },
        });
      }
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
          `[payments] withdrawal ${merchantTransactionId} submit outcome AMBIGUOUS (${unconfirmed(error)}) — left pending for the sweep`,
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
      ...(fx ? { currency: fx.currency, payAmount: fx.gatewayAmount } : {}),
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
    ...(fx ? { currency: fx.currency, payAmount: fx.gatewayAmount } : {}),
  };
}

/** The ambiguous log's reason: says when a refusal was not confirmed. */
const unconfirmed = (error: unknown): string =>
  error instanceof GatewayError && error.definite
    ? `refusal not confirmed: the gateway holds this payout or could not be asked — ${error.message}`
    : (error as Error).message;

type RefusalVerdict = {
  /** The gateway holds no such payout: refund and close the row. */
  refund: boolean;
  payoutDisabled: boolean;
  floatEmpty: boolean;
  /** Close the gateway to the next customer (see floatCannotPayAnything). */
  trip: boolean;
  /** The gateway holds the payout after all: its id, for the pending row. */
  heldId: string | null;
};

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
 * Payouts switched off (TGPAY_PAYOUT_DISABLED) is the one refusal taken at
 * its word: an exact path + 501 + text that means nothing was created
 * (#747). Asking first left such a payout pending for good, since The 7
 * Pay's lookup need not answer while its payouts are off.
 */
async function judgeRefusal(
  error: GatewayError,
  input: {
    gateway: PaymentGateway;
    config: GatewayConfig;
    fx: RowFx;
    gatewayAmount: number | null;
    merchantTransactionId: string;
  },
): Promise<RefusalVerdict> {
  const payoutDisabled = error.has(TGPAY_PAYOUT_DISABLED);
  const floatEmpty = payoutDisabled
    ? null
    : await floatEmptyRefusal(
        error,
        input.gateway,
        input.config,
        input.gatewayAmount,
      );
  const kind = {
    payoutDisabled,
    floatEmpty: floatEmpty !== null,
    trip: payoutDisabled || Boolean(floatEmpty?.trip),
  };
  if (payoutDisabled) return { ...kind, refund: true, heldId: null };
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
    return {
      ...kind,
      refund: classifyRequeryError(lookupError).kind === 'not-found',
      heldId: null,
    };
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
    payoutFloatEmptyUntil.set(gateway, Date.now() + PAYOUT_FLOAT_COOLDOWN_MS);
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
  const closed = await packs.updateGatewayWithdrawals({
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
  // The close is scoped to fromStatus. Losing it after the refund committed
  // is harmless when another refund closed the row first, but not when a
  // SUCCESS for the same payout claimed it in between (a FAIL and a SUCCESS
  // racing): the customer is then refunded AND paid, and nothing else says so.
  if (Array.isArray(closed) && closed.length === 0) {
    const [row] = await packs.listGatewayWithdrawals(
      { id: withdrawal.id },
      { take: 1 },
    );
    if (row?.status === 'settled') {
      void alertOps(
        scope,
        `refund-vs-settled:${withdrawal.merchant_transaction_id}`,
        `Payout ${withdrawal.merchant_transaction_id} (customer ${withdrawal.customer_id}) was REFUNDED RM ${Number(withdrawal.amount)}, but a success for it settled the row at the same moment. If the gateway really paid, the customer has the money twice: check the gateway's record and recover the refund by hand.`,
      );
    }
  }
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
  /** The gateway leg (payment-fx.ts). Read only to word the USDT receipt. */
  currency?: unknown;
  gateway_amount?: unknown;
};

/** The USDT the wallet received, for the paid receipt and bell row; undefined
 *  on every other rail, whose notices stay RM-and-bank worded. */
function usdtPaidAmount(row: WithdrawalOutcomeRow): number | undefined {
  const amount = Number(row.gateway_amount);
  return row.currency === 'USDT' && Number.isFinite(amount) && amount > 0
    ? amount
    : undefined;
}

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
  const usdtAmount = usdtPaidAmount(withdrawal);
  const gatewayTransactionId = outcome.gatewayTransactionId || null;

  await sendWithdrawalReceipt(scope, {
    customerId: withdrawal.customer_id,
    amount,
    reference: outcome.gatewayRef,
    merchantTransactionId: withdrawal.merchant_transaction_id,
    outcome: 'paid',
    ...(usdtAmount !== undefined ? { usdtAmount } : {}),
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
        data: {
          amount_myr: amount,
          reference: outcome.gatewayRef,
          ...(usdtAmount !== undefined ? { usdt_amount: usdtAmount } : {}),
        },
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
  // Cheap early exit only: the gate that counts is the ROW's own gateway,
  // checked below before the claim. Asking the ACTIVE gateway here refused
  // every held A3Pay payout whenever TGPay payouts were off (review, #755).
  if (!anyWithdrawalsEnabled()) {
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

  // Held rows can predate bank validation; refuse before claiming or sending.
  const detailsInvalid = withdrawalDetailsError({
    bankCode: row.bank_code,
    accountNumber: row.account_number,
    accountHolderName: row.account_holder_name,
  });
  if (detailsInvalid) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `${detailsInvalid} Deny this withdrawal and ask the customer to save the correct bank details.`,
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
    !withdrawalsEnabled(process.env, gatewayId) ||
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

  // OUR regional float (A3Pay's SGD balance) must cover the locked amount.
  // Checked before the claim, so a short float leaves the row HELD for an
  // approval after the top-up instead of refunding the customer.
  if (row.gateway_amount != null && !isLedgerGateway(gatewayId)) {
    const short = await regionalFloatShort(config, Number(row.gateway_amount));
    if (short) {
      if (floatCannotPayAnything(gatewayId, short)) {
        payoutFloatEmptyUntil.set(
          gatewayId,
          Date.now() + PAYOUT_FLOAT_COOLDOWN_MS,
        );
      }
      const label = GATEWAYS[gatewayId].label;
      void alertPayoutFloatEmpty(scope, {
        amount,
        ref: row.merchant_transaction_id,
        via: 'admin approve (balance pre-check)',
        gateway: label,
      });
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Our ${label} balance (${short.currency} ${short.available.toFixed(2)} available) cannot cover this payout (${short.currency} ${Number(row.gateway_amount).toFixed(2)}). The withdrawal stays held — fund the ${label} balance, then approve it again.`,
      );
    }
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
        // The quote locked when the customer asked, never today's rate.
        ...(row.gateway_amount != null
          ? { gatewayAmount: Number(row.gateway_amount) }
          : {}),
      },
      config,
    );
  } catch (error) {
    // Both branches mirror startWithdrawal's post-#425 shape exactly.
    // There is no third path: an outcome that is not a PARSED refusal is
    // ambiguous, and ambiguity must never refund. A refusal the gateway does
    // not confirm (judgeRefusal) is ambiguous too.
    const verdict =
      error instanceof GatewayError && error.definite
        ? await judgeRefusal(error, {
            gateway: gatewayId,
            config,
            fx: rowFx(row),
            gatewayAmount:
              row.gateway_amount != null ? Number(row.gateway_amount) : null,
            merchantTransactionId: row.merchant_transaction_id,
          })
        : null;
    if (error instanceof GatewayError && verdict?.refund) {
      // The gateway parseably refused and, asked, holds no such payout.
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
      // Same cause and same handling as startWithdrawal's branch: the refund
      // above is untouched, only the words and the ops alert differ.
      const label = GATEWAYS[gatewayId].label;
      warnOps(scope, verdict, gatewayId, {
        amount,
        ref: row.merchant_transaction_id,
        via: 'admin approve',
      });
      if (verdict.payoutDisabled) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `${label} refused this payout because payouts are not enabled on our ${label} account ("Payout not available"). The debit has been refunded and the withdrawal closed. Ask ${label} to enable payouts, or switch back to a gateway that pays out, then ask the customer to request the withdrawal again.`,
        );
      }
      if (verdict.floatEmpty) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `${label} refused this payout because our ${label} payout wallet is short ("Insufficient payout credit balance"). The debit has been refunded and the withdrawal closed. Top up the payout wallet, then ask the customer to request the withdrawal again.`,
        );
      }
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'The gateway refused this payout. The debit has been refunded and the withdrawal closed.',
      );
    }
    if (verdict) {
      // Refused, but not confirmed: as on the customer path.
      warnOps(scope, verdict, gatewayId, {
        amount,
        ref: row.merchant_transaction_id,
        via: 'admin approve',
      });
      if (verdict.heldId && error instanceof GatewayError) {
        await packs.updateGatewayWithdrawals({
          selector: { id: row.id, status: 'pending' },
          data: {
            gateway_transaction_id: verdict.heldId,
            failure_reason: formatGatewayFailureReason({
              prefix: 'approve refused, but the gateway holds it',
              codes: error.codes,
              httpStatus: error.httpStatus,
              bankCode: row.bank_code,
              message: error.message,
              accountNumber: row.account_number,
              accountHolderName: row.account_holder_name,
            }),
          },
        });
      }
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
        `[payments] admin ${adminId} approved withdrawal ${row.merchant_transaction_id} but the submit outcome is AMBIGUOUS (${unconfirmed(error)}) — left pending for the sweep`,
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
