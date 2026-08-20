import { randomUUID } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from './index';
import type PacksModuleService from './service';
import {
  globepayConfigFromEnv,
  submitDeposit,
  GlobePayError,
} from './globepay-client';
import { topUpAmountError } from './topup';

// The submit half of the GlobePay365 deposit loop: record intent, ask the
// gateway for a cashier page, hand the customer the URL. NO credit is issued
// here — that happens only when a verified callback reports status 6
// (src/api/hooks/globepay/deposit/route.ts).

/**
 * Fallback MYR deposit method when neither the request nor the environment
 * names one. BQR is the only channel provisioned on STAGING — production
 * refused it on 2026-08-04 with `PMT10006 Invalid Payment Method`, which is
 * why the value is now overridable per environment (see below) instead of
 * being a constant that costs a code deploy to change.
 */
export const GLOBEPAY_DEFAULT_METHOD = 'BQR';

/**
 * The MYR deposit methods (doc "Deposit Method Appendix"). The client sends
 * CurrencyCode: MYR, but PaymentMethodCode comes from the request body — so
 * without this list a caller could ask for a method belonging to another
 * currency (UPI, MOMO, BKASH…) and depend on gateway-side behaviour we cannot
 * see. Allow-list, not deny-list: an unknown code is rejected.
 */
export const GLOBEPAY_MYR_METHODS = ['FPX', 'DN', 'BQR', 'OB'] as const;

/**
 * How many deposits one customer may have awaiting payment at once, and the
 * window that cap is measured over.
 *
 * The row is written BEFORE the gateway call and an UNPAID deposit requeries as
 * statusId 4 (VerifyFail), which depositState maps to 'pending' — not 'failed'.
 * So an unpaid row stays selectable until it ages past GLOBEPAY_STALE_AFTER_MS
 * and a sweep actually looks at it. The sweep selects oldest-first with a fixed
 * LIMIT (GLOBEPAY_RECONCILE_BATCH), which means a customer who opens cashier
 * sessions and never pays can hold the front of that queue indefinitely and
 * starve everyone else's PAID deposits of the only path that credits them
 * (callbacks are not delivered in production — the sweep is the sole writer).
 *
 * The window matters as much as the cap: there is no customer-facing cancel or
 * abandon endpoint, so a pending row only leaves 'pending' via settle, fail, or
 * the sweep-driven expire. An UNSCOPED cap would lock a customer who merely
 * closed a few cashier tabs out of depositing until the sweep caught up. Scoped
 * to a window, an abandoned session stops counting against them on its own.
 */
export const GLOBEPAY_MAX_RECENT_PENDING_PER_CUSTOMER = 5;
export const GLOBEPAY_PENDING_WINDOW_MS = 20 * 60 * 1000;

/**
 * Per-transaction limits for the PRODUCTION merchant account, confirmed by the
 * provider 2026-07-29 (Sean): Online Banking bank-to-bank and QR e-wallet both
 * RM 30 – RM 10,000. The old RM 30–1,000 ceiling was the TEST account's, probed
 * live on 2026-07-22 (1000 accepted, 1001 → PMT10005) — re-probe on production
 * before treating 10,000 as verified rather than stated.
 *
 * Enforced HERE as well as in the storefront so an amount that cannot possibly
 * succeed never costs a network round-trip or leaves a failed row behind. Their
 * own rejection is a bare "Invalid Transaction Amount" with no bounds in it.
 */
export const GLOBEPAY_MIN_RM = 30;
export const GLOBEPAY_MAX_RM = 10000;

/**
 * Is the real gateway switched on? Mirrors mockTopupAllowed's fail-closed
 * shape: absent config means "not configured", never a silent fallback that
 * mints free credit. Pure (env injected) so the policy is unit-testable.
 */
export function globepayEnabled(
  env: {
    GLOBEPAY_ENABLED?: string;
    GLOBEPAY_MERCHANT_CODE?: string;
  } = process.env,
): boolean {
  return env.GLOBEPAY_ENABLED === 'true' && Boolean(env.GLOBEPAY_MERCHANT_CODE);
}

/**
 * Our reference, sent as MerchantTransactionId. Deliberately opaque: it shows
 * up in GlobePay365's back office, so it must NOT carry a customer id (the
 * callback carries this value back, and the globepay_deposit row is what maps
 * it to a customer). Prefixed so a human can spot ours in their listing.
 */
export function newMerchantTransactionId(): string {
  return `PC-${randomUUID().replace(/-/g, '')}`;
}

export type StartDepositInput = {
  /** From the verified token — NEVER the request body. */
  customerId: string;
  /** Raw body value; validated here with the same rules as the mock top-up. */
  amount: unknown;
  /** The CUSTOMER's IP (they require it), not our server's. */
  ipAddress: string;
  paymentMethodCode?: string;
};

export type StartDepositResult = {
  /** Where to send the customer. Always redirect — it renders their errors too. */
  url: string;
  /** Their deposit id, for support/reconciliation. */
  transactionId: string;
  /** Our reference. */
  merchantTransactionId: string;
  amount: number;
  /** Bank/QR details for methods that render in-page instead of redirecting. */
  bankCode?: string | null;
  accountNumber?: string | null;
  accountHolderName?: string | null;
  referenceNo?: string | null;
  qrCode?: string | null;
};

/**
 * Create a deposit. The row is written BEFORE the gateway call so a callback
 * can never arrive for a reference we have no record of — their callback echoes
 * MerchantTransactionId but not MerchantClientId, so that row is the only way
 * back to a customer.
 */
export async function startGlobePayDeposit(
  scope: { resolve: <T>(key: string) => T },
  input: StartDepositInput,
  notifyUrl: string,
  returnUrl: string,
): Promise<StartDepositResult> {
  if (!globepayEnabled()) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Top-ups are temporarily unavailable.',
    );
  }

  const invalid = topUpAmountError(input.amount);
  if (invalid) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, invalid);
  }
  const amount = input.amount as number;

  // The gateway's own band, said in numbers because their refusal is a bare
  // "Invalid Transaction Amount". Since 2026-07-29 the production ceiling
  // (RM 10,000) is EXACTLY the site-wide TOPUP_MAX_RM, which is checked above,
  // so in practice only the floor arrives here — anything over 10,000 is
  // already refused as "at most RM 10,000 per top-up". Both bounds stay
  // asserted anyway: TOPUP_MAX_RM is an anti-typo guard that answers to us,
  // the band answers to them, and they are free to move apart again.
  if (amount < GLOBEPAY_MIN_RM || amount > GLOBEPAY_MAX_RM) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Top-ups must be between RM ${GLOBEPAY_MIN_RM} and RM ${GLOBEPAY_MAX_RM.toLocaleString('en-US')}.`,
    );
  }

  // GLOBEPAY_DEPOSIT_METHOD names the channel to use when the caller does not.
  // It was the operator's channel lever: which of FPX/DN/BQR/OB is provisioned
  // is GlobePay's decision, differs between staging and production, and is not
  // discoverable from our side except by being refused, so an env var (~4 minute
  // spec apply) beat a ~10 minute build per guess.
  //
  // Since 2026-08-06 it is a FALLBACK ONLY for customer traffic: the storefront
  // top-up sheet lets the customer pick, so every request from it names a
  // method and this default can never fire. The lever moved with it — retracting
  // a channel is now DEPOSIT_METHODS_ENABLED on the STOREFRONT app
  // (src/lib/deposit-methods.ts), also RUN_TIME, also no rebuild. This value
  // still covers any caller that sends no method, so keep it on a provisioned
  // channel.
  //
  // Validated against the allow-list below either way, so a typo fails closed on
  // OUR side rather than reaching the gateway. Note the allow-list is the
  // gateway's whole MYR set, which is WIDER than what this merchant has
  // provisioned — it will happily pass DN or FPX through to a cashier that
  // refuses them.
  const paymentMethodCode =
    input.paymentMethodCode ??
    process.env.GLOBEPAY_DEPOSIT_METHOD ??
    GLOBEPAY_DEFAULT_METHOD;
  if (
    !(GLOBEPAY_MYR_METHODS as readonly string[]).includes(paymentMethodCode)
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Unsupported payment method.',
    );
  }

  const config = globepayConfigFromEnv();
  const packs = scope.resolve<PacksModuleService>(PACKS_MODULE);

  const merchantTransactionId = newMerchantTransactionId();

  // Bound the customer's own share of the reconcile sweep's fixed-LIMIT,
  // oldest-first queue. Without this, creating cashier sessions and never
  // paying is free and unbounded, and the resulting backlog delays or prevents
  // OTHER customers' paid deposits from ever being credited.
  //
  // The count and the insert happen inside ONE customer-locked transaction in
  // the service (#429). Counting here and inserting afterwards let N concurrent
  // submits each read N−1 and all pass, so the cap could be overshot by exactly
  // the number of requests in flight. `null` back means the cap is reached, and
  // nothing was written — so nothing reaches the gateway either.
  const row = await packs.createGlobePayDepositCapped({
    data: {
      merchant_transaction_id: merchantTransactionId,
      customer_id: input.customerId,
      amount_requested: amount,
      payment_method_code: paymentMethodCode,
      status: 'pending',
    },
    maxRecentPending: GLOBEPAY_MAX_RECENT_PENDING_PER_CUSTOMER,
    windowMs: GLOBEPAY_PENDING_WINDOW_MS,
  });
  if (!row) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'You have several top-ups still waiting for payment. Finish one, or wait a few minutes before starting another.',
    );
  }

  let result;
  try {
    result = await submitDeposit(
      {
        merchantTransactionId,
        // Their support/reconciliation view. Our customer id is already opaque
        // and is not usable to reach the account, unlike an email.
        merchantClientId: input.customerId,
        amount,
        notifyUrl,
        returnUrl,
        ipAddress: input.ipAddress,
        paymentMethodCode,
      },
      config,
    );
  } catch (error) {
    if (error instanceof GlobePayError && error.definite) {
      // Only a DEFINITIVE rejection closes the row: their API answered and said
      // no, so no deposit exists on their side and no callback will ever
      // arrive. Close it out rather than leaving it pending and polluting the
      // reconciliation sweep forever.
      //
      // `definite` is load-bearing, not decoration. A timeout, socket reset or
      // WAF page also arrives as a GlobePayError, with definite=false, and
      // means the submit MAY have been accepted and only the response lost
      // (see the class doc in globepay-client.ts). Closing those took a live
      // deposit out of the sweep's status='pending' scan permanently — the
      // sibling test at globepay-deposit.unit.spec.ts already asserted the
      // opposite of what this branch did, and passed only because it mocked a
      // raw SyntaxError, a shape the client never actually throws.
      await packs.updateGlobePayDeposits({ id: row.id, status: 'failed' });
      // Log their reason before it is flattened into the customer-facing
      // message below — this is the ONLY point we ever observe it, since the
      // row records status 'failed' with no code. Without it the 2026-08-04
      // cutover had a live deposit failing with no way to tell a bad key from
      // an unprovisioned payment method from an IP the gateway refuses.
      //
      // AFTER the status update. The try/catch below already covers a logger
      // that THROWS, so ordering is not what protects the row write from that;
      // what it still buys is protection from a logger that HANGS — a blocked
      // transport or a full disk — which no catch can rescue. The cost is a
      // blind spot: if updateGlobePayDeposits itself throws, the refusal never
      // reaches the logs. Accepted, because a hung logger stranding the row
      // write is worse than a rare unlogged double failure. Same trade as the
      // payout branch (globepay-withdrawal.ts), which these two are kept
      // deliberately parallel to.
      //
      // `error.message` carries the diagnosis when `codes` is empty — a
      // non-JSON/WAF response (an un-allowlisted IP lands here) is built from
      // the response text alone, see globepay-client.ts. Safe to log: their
      // codes and message, the HTTP status, our own opaque reference, the
      // method and the amount. NEVER the request or response envelope — those
      // carry the signed/encrypted body.
      //
      // Best-effort. Without the catch, a throw from `resolve` or `warn`
      // escapes in place of the MedusaError below and the customer gets a 500
      // instead of the sentence telling them to try another amount or method.
      try {
        scope
          .resolve<{ warn: (message: string) => void }>('logger')
          .warn(
            `[globepay] deposit refused: codes=${error.codes.join(',') || 'none'} ` +
              `httpStatus=${error.httpStatus} definite=${error.definite} ` +
              `method=${paymentMethodCode} amount=${amount} ref=${merchantTransactionId} ` +
              `msg=${error.message}`,
          );
      } catch {
        // Swallowed deliberately: the logger is the thing that failed, so there
        // is nothing left to report it with.
      }
      // Their validation errors are the customer's problem to fix (amount out
      // of range, method unavailable), not a 500.
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'We could not start your top-up. Please try a different amount or payment method.',
      );
    }
    // Anything else — timeout, socket reset, an unparseable response — is
    // AMBIGUOUS: the submit may well have landed at the gateway. Leave the row
    // 'pending' so the reconciliation sweep requeries it, because requery is
    // the authoritative answer (globepay-reconcile.ts). Marking it 'failed'
    // here would drop it out of the sweep's status='pending' scan permanently
    // and strand a real payment.
    //
    // Say so before rethrowing, for the same reason the refusal above is
    // logged: this branch CREATES a pending row and nothing else records why.
    // The rethrow reaches Medusa's default handler, which logs the bare error
    // message — no reference, no method, no amount — so without this line the
    // row and the cause it came from cannot be tied together. The payout twin
    // has logged its ambiguous outcome all along (globepay-withdrawal.ts); this
    // is the half of that parallel the deposit path was missing.
    //
    // Guarded like the refusal log: a throw from the logger here would replace
    // the gateway error with its own, and the gateway error is what the sweep's
    // operator needs to read.
    try {
      scope
        .resolve<{ error: (msg: string) => void }>('logger')
        .error(
          `[globepay] deposit ${merchantTransactionId} submit outcome AMBIGUOUS ` +
            `(${(error as Error).message}) — left pending for the sweep`,
        );
    } catch {
      // Swallowed deliberately: the logger is the thing that failed. The row
      // stays 'pending', so the sweep still resolves this deposit whether or
      // not anyone ever reads about it.
    }
    throw error;
  }

  await packs.updateGlobePayDeposits({
    id: row.id,
    gateway_transaction_id: result.transactionId,
  });

  return {
    url: result.url,
    transactionId: result.transactionId,
    merchantTransactionId,
    amount,
    bankCode: result.bankCode,
    accountNumber: result.accountNumber,
    accountHolderName: result.accountHolderName,
    referenceNo: result.referenceNo,
    qrCode: result.qrCode,
  };
}
