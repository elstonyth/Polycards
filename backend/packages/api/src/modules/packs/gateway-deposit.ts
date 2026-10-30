import { randomUUID } from 'node:crypto';
import { MedusaError } from '@medusajs/framework/utils';
import { resolvePacks, type GatewayDeposits } from './facets';
import {
  GATEWAYS,
  gatewayConfigFor,
  paymentGateway,
  rowGateway,
  submitDeposit,
  GatewayError,
  GATEWAY_IDS,
  isLedgerGateway,
  type PaymentGateway,
} from './gateway';
import {
  creditForDeposit,
  loadPaymentFxQuote,
  nudgedDeposit,
  regionalDepositBand,
} from './payment-fx';
import type { TgpayCustomer } from './tgpay-client';
import { topUpAmountError, topupIdempotencyReference } from './topup';
import { sendTopupReceipt } from './topup-receipt';
import { notifyFeed } from './notify-feed';
import { topupFeedKey } from './feed-events';
import type { DEPOSIT_STATUSES } from './models/gateway-deposit';
import { gatewayEnv } from './gateway-env';
import { alertOps } from './ops-alert';
import { PAYIN_STATUS } from './a3pay';

/**
 * An A3Pay-platform payin at status 4 (Verify Fail): the gateway could not
 * match the payment to the payer we named (A3Pay compares the account name).
 * Not final, so nothing changes on the row — but the customer may well have
 * paid, so a human must look. Once per deposit per 6 hours (callback retries
 * and the 1-minute sweep both report it).
 */
export function alertPayinVerifyFail(
  scope: { resolve: <T>(key: string) => T },
  deposit: {
    merchant_transaction_id: string;
    customer_id: string;
    gateway?: string | null;
  },
): void {
  const gateway = rowGateway(deposit);
  const name = gateway ? GATEWAYS[gateway].label : 'The gateway';
  const head = `${name} reports Verify Fail (status 4) on deposit ${deposit.merchant_transaction_id} (customer ${deposit.customer_id})`;
  void alertOps(
    scope,
    `payin-verify-fail:${deposit.merchant_transaction_id}`,
    // GlobePay365 (2026-10-20, staging): an order not paid in full in time,
    // or paid a different amount, is status 4, and its record keeps the
    // ORDER amount, never what arrived.
    gateway === 'gp365'
      ? `${head} — the order was not paid in time, or the USDT that arrived differs from the order (GlobePay365 treats that as unpaid). No action unless the customer shows proof of a transfer; then ask GlobePay365 to resolve it by hand: refund what arrived, or mark the order successful ONLY once the full amount has arrived (their record shows the order amount, so a successful mark credits the full order). Never credit it by admin adjustment: the sweep could credit it a second time.`
      : `${head} — ${name} matches a payment ONLY by its exact amount (cents included), so the customer most likely never transferred it or sent a different sum. No action unless they show proof of payment; then ask ${name} to match it in their back office so the callback credits it. Never credit it by admin adjustment: the sweep could credit it a second time.`,
    { muteMs: 6 * 60 * 60 * 1000 },
  );
}

/**
 * Does the SWEEP alert on this Verify Fail? Only while the row is pending: an
 * expired row is requeried for days, and every pass re-alerted an abandoned
 * order (the mute lives in one process's memory). A callback still alerts.
 */
export function sweepAlertsVerifyFail(
  deposit: { gateway?: string | null; status: string },
  statusId: unknown,
): boolean {
  return deposit.status === 'pending' && isPayinVerifyFail(deposit.gateway, statusId);
}

/** Payin status 4 from a tenant of the A3Pay platform (A3Pay, GlobePay365). */
export function isPayinVerifyFail(
  gateway: string | null | undefined,
  statusId: unknown,
): boolean {
  return (
    (gateway === 'a3pay' || gateway === 'gp365') &&
    Number(statusId) === PAYIN_STATUS.VERIFY_FAIL
  );
}

/** The gateway_deposit.status domain, from the model. */
type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

// The submit half of the gateway deposit loop: record intent, ask the
// gateway for a cashier page, hand the customer the URL. NO credit is issued
// here — that happens only when a verified callback reports the gateway's
// success status (TGPay: `APPROVED`) — src/api/hooks/tgpay/deposit/route.ts.

/**
 * Fallback MYR deposit method when neither the request nor the environment
 * names one. BQR is the only channel provisioned on STAGING — production
 * refused it on 2026-08-04 with `PMT10006 Invalid Payment Method`, which is
 * why the value is now overridable per environment (see below) instead of
 * being a constant that costs a code deploy to change.
 */
export const GATEWAY_DEFAULT_METHOD = 'BQR';

/**
 * The MYR deposit methods (doc "Deposit Method Appendix"). The client sends
 * CurrencyCode: MYR, but PaymentMethodCode comes from the request body — so
 * without this list a caller could ask for a method belonging to another
 * currency (UPI, MOMO, BKASH…) and depend on gateway-side behaviour we cannot
 * see. Allow-list, not deny-list: an unknown code is rejected.
 */
export const GATEWAY_MYR_METHODS = ['FPX', 'DN', 'BQR', 'OB'] as const;

/**
 * How many deposits one customer may have awaiting payment at once, and the
 * window that cap is measured over.
 *
 * The row is written BEFORE the gateway call and an UNPAID deposit requeries as
 * statusId 4 (VerifyFail), which depositState maps to 'pending' — not 'failed'.
 * So an unpaid row stays selectable until it ages past GATEWAY_STALE_AFTER_MS
 * and a sweep actually looks at it. The sweep selects oldest-first with a fixed
 * LIMIT (GATEWAY_RECONCILE_BATCH), which means a customer who opens cashier
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
export const GATEWAY_MAX_RECENT_PENDING_PER_CUSTOMER = 5;
export const GATEWAY_PENDING_WINDOW_MS = 20 * 60 * 1000;

/**
 * The site-wide deposit ceiling (== TOPUP_MAX_RM, topup.ts) — not a
 * per-gateway figure. Per-gateway bands live on `GATEWAYS[id].limits`
 * (gateway.ts); TGPay's deposit band is 50–10,000, so this constant is
 * currently the binding (lower) ceiling of the two. Doubles as the sweep's
 * quarantine ceiling (gateway-reconcile.ts): a requeried amount above this
 * is left for manual settlement rather than auto-credited.
 *
 * Enforced HERE as well as in the storefront so an amount that cannot possibly
 * succeed never costs a network round-trip or leaves a failed row behind.
 */
export const GATEWAY_MAX_RM = 10000;

/**
 * Is the real gateway switched on? Mirrors mockTopupAllowed's fail-closed
 * shape: absent config means "not configured", never a silent fallback that
 * mints free credit. Pure (env injected) so the policy is unit-testable.
 */
export function gatewayEnabled(
  env: Partial<NodeJS.ProcessEnv> = process.env,
  gateway: PaymentGateway = paymentGateway(env),
): boolean {
  // GATEWAY_ENABLED is the master "real gateway" switch (read through
  // gatewayEnv, which still accepts its legacy name); the credential that
  // proves a gateway is configured is that gateway's own. Callers that
  // already pinned a gateway for the request pass it, so the check and the
  // submit cannot straddle an admin switch.
  return (
    gatewayEnv('GATEWAY_ENABLED', env) === 'true' &&
    GATEWAYS[gateway].configured(env)
  );
}

/** Is ANY gateway open for deposits? The sweeps' gate: rows of every open
 *  gateway keep settling, whichever one is active. */
export function anyGatewayEnabled(
  env: Partial<NodeJS.ProcessEnv> = process.env,
): boolean {
  // The active gateway first (in specs that is the test-only fake, which
  // GATEWAY_IDS deliberately omits), then every registered one.
  return (
    gatewayEnabled(env) || GATEWAY_IDS.some((id) => gatewayEnabled(env, id))
  );
}

/**
 * The open regional gateway for a customer-chosen currency (SGD -> A3Pay), or
 * null. A top-up in RM always goes to the ACTIVE gateway instead.
 */
export function regionalDepositGateway(
  currency: string,
  env: Partial<NodeJS.ProcessEnv> = process.env,
): PaymentGateway | null {
  return (
    GATEWAY_IDS.find(
      (id) =>
        !isLedgerGateway(id) &&
        GATEWAYS[id].currency === currency.toUpperCase() &&
        gatewayEnabled(env, id),
    ) ?? null
  );
}

/**
 * Our reference, sent as MerchantTransactionId. Deliberately opaque: it shows
 * up in the gateway's back office, so it must NOT carry a customer id (the
 * callback carries this value back, and the gateway_deposit row is what maps
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
  /** Name/email/phone — TGPay requires it on create-payment (needsCustomerContact). */
  customer?: TgpayCustomer;
  /** Name on the paying bank account — regional gateways (A3Pay) only. */
  payerName?: string;
  /** The deposit rate (RM per unit) the customer was shown; regional only. */
  quotedRate?: number;
  /**
   * The gateway this deposit goes through. The route resolves it ONCE and
   * passes it down so the config, the row stamp and the callback URLs all
   * name the same gateway even if an admin flips the switch mid-request.
   * Defaults to the active gateway for callers that have no opinion.
   */
  gateway?: PaymentGateway;
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
export async function startDeposit(
  scope: { resolve: <T>(key: string) => T },
  input: StartDepositInput,
  notifyUrl: string,
  returnUrl: string,
): Promise<StartDepositResult> {
  const gateway = input.gateway ?? paymentGateway();
  if (!gatewayEnabled(process.env, gateway)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Top-ups are temporarily unavailable.',
    );
  }

  const packs = resolvePacks<GatewayDeposits>(scope);

  // A regional gateway (A3Pay, SGD): the customer names what they PAY, in
  // that currency, and the RM credit is quoted from it now and locked on the
  // row. Everything below the quote runs on the RM credit exactly as for an
  // RM gateway — the same site ceiling, the same RM band, the same fences.
  const regional = !isLedgerGateway(gateway);
  let fx: {
    currency: string;
    gatewayAmount: number;
    mid: number;
    markup: number;
  } | null = null;
  let creditAmount: unknown = input.amount;
  if (regional) {
    const { currency, currencyLimits } = GATEWAYS[gateway];
    const paid = input.amount;
    if (
      typeof paid !== 'number' ||
      !Number.isFinite(paid) ||
      paid <= 0 ||
      Math.abs(paid * 100 - Math.round(paid * 100)) > 1e-6
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'Enter a valid amount.',
      );
    }
    const quote = await loadPaymentFxQuote(packs, currency);
    // The rate the customer was shown, when the client sent one: never credit
    // at a rate they did not see (an admin may have changed the fee since
    // the sheet loaded). Before any row.
    if (
      input.quotedRate !== undefined &&
      Math.abs(Number(input.quotedRate) - quote.depositRate) > 1e-9
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'The exchange rate just changed. Check the new amount and try again.',
      );
    }
    // Today's S$ band: the gateway's own, narrowed so the converted credit
    // also fits the RM band — refused here in S$, not later in RM.
    const band = currencyLimits
      ? regionalDepositBand(
          quote,
          currencyLimits,
          GATEWAYS[gateway].limits,
          GATEWAYS[gateway].payinNudgeCents,
        )
      : null;
    if (band && (paid < band.min || paid > band.max)) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `Top-ups must be between ${currency} ${band.min.toFixed(2)} and ${currency} ${band.max.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}.`,
      );
    }
    creditAmount = creditForDeposit(paid, quote);
    fx = {
      currency,
      gatewayAmount: paid,
      mid: quote.mid,
      markup: quote.depositMarkup,
    };
  }

  // A regional top-up is bounded by its own S$ band (above), which credits
  // past the site-wide RM ceiling at S$5,000; its RM fence is its own.
  const invalid = topUpAmountError(
    creditAmount,
    fx ? GATEWAYS[gateway].limits.depositMax : undefined,
  );
  if (invalid) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, invalid);
  }
  const amount = creditAmount as number;

  // The gateway's own band, said in numbers because their refusal is a bare
  // "Invalid Transaction Amount". Since 2026-07-29 the production ceiling
  // (RM 10,000) is EXACTLY the site-wide TOPUP_MAX_RM, which is checked above,
  // so in practice only the floor arrives here — anything over 10,000 is
  // already refused as "at most RM 10,000 per top-up". Both bounds stay
  // asserted anyway: TOPUP_MAX_RM is an anti-typo guard that answers to us,
  // the band answers to them, and they are free to move apart again.
  const { depositMin, depositMax } = GATEWAYS[gateway].limits;
  if (amount < depositMin || amount > depositMax) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `Top-ups must be between RM ${depositMin} and RM ${depositMax.toLocaleString('en-US')}.`,
    );
  }

  // The storefront top-up sheet always names a method; the default only
  // covers a caller that sends none. Retracting a channel is
  // DEPOSIT_METHODS_ENABLED on the STOREFRONT app (src/lib/deposit-methods.ts).
  // Validated against the rail allow-list below either way, so a typo fails
  // closed on OUR side rather than reaching the gateway; each adapter then
  // maps the rail code onto its own channels (or refuses it as definite).
  const paymentMethodCode = input.paymentMethodCode ?? GATEWAY_DEFAULT_METHOD;
  const methods: readonly string[] = regional
    ? (GATEWAYS[gateway].depositMethods ?? [])
    : GATEWAY_MYR_METHODS;
  if (!methods.includes(paymentMethodCode)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Unsupported payment method.',
    );
  }

  // The name on the PAYING account (A3Pay matches it against the transfer).
  // Refused here, before any row, rather than as the adapter's definite
  // refusal after one.
  const payerName =
    typeof input.payerName === 'string' ? input.payerName.trim() : '';
  const needsPayerName = GATEWAYS[gateway].needsPayerName === true;
  if (needsPayerName && (payerName.length < 2 || payerName.length > 120)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Enter the name on the bank account you are paying from (reload the page if you see no name field).',
    );
  }

  const config = gatewayConfigFor(gateway);

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
  const row = await packs.createDepositCapped({
    data: {
      merchant_transaction_id: merchantTransactionId,
      customer_id: input.customerId,
      amount_requested: amount,
      payment_method_code: paymentMethodCode,
      status: 'pending',
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
    maxRecentPending: GATEWAY_MAX_RECENT_PENDING_PER_CUSTOMER,
    windowMs: GATEWAY_PENDING_WINDOW_MS,
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
        customer: input.customer,
        ...(fx ? { gatewayAmount: fx.gatewayAmount } : {}),
        ...(needsPayerName ? { payerName } : {}),
      },
      config,
    );
  } catch (error) {
    if (error instanceof GatewayError && error.definite) {
      // Only a DEFINITIVE rejection closes the row: their API answered and said
      // no, so no deposit exists on their side and no callback will ever
      // arrive. Close it out rather than leaving it pending and polluting the
      // reconciliation sweep forever.
      //
      // `definite` is load-bearing, not decoration. A timeout, socket reset or
      // WAF page also arrives as a GatewayError, with definite=false, and
      // means the submit MAY have been accepted and only the response lost
      // (see GatewayError in gateway-types.ts). Closing those took a live
      // deposit out of the sweep's status='pending' scan permanently — the
      // sibling test at gateway-deposit.unit.spec.ts already asserted the
      // opposite of what this branch did, and passed only because it mocked a
      // raw SyntaxError, a shape the client never actually throws.
      await packs.updateGatewayDeposits({ id: row.id, status: 'failed' });
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
      // blind spot: if updateGatewayDeposits itself throws, the refusal never
      // reaches the logs. Accepted, because a hung logger stranding the row
      // write is worse than a rare unlogged double failure. Same trade as the
      // payout branch (gateway-withdrawal.ts), which these two are kept
      // deliberately parallel to.
      //
      // `error.message` carries the diagnosis when `codes` is empty — a
      // non-JSON/WAF response (an un-allowlisted IP lands here) is built from
      // the response text alone, see tgpay-client.ts. Safe to log: their
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
            `[payments] deposit refused: codes=${error.codes.join(',') || 'none'} ` +
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
    // the authoritative answer (gateway-reconcile.ts). Marking it 'failed'
    // here would drop it out of the sweep's status='pending' scan permanently
    // and strand a real payment.
    //
    // Say so before rethrowing, for the same reason the refusal above is
    // logged: this branch CREATES a pending row and nothing else records why.
    // The rethrow reaches Medusa's default handler, which logs the bare error
    // message — no reference, no method, no amount — so without this line the
    // row and the cause it came from cannot be tied together. The payout twin
    // has logged its ambiguous outcome all along (gateway-withdrawal.ts); this
    // is the half of that parallel the deposit path was missing.
    //
    // Guarded like the refusal log: a throw from the logger here would replace
    // the gateway error with its own, and the gateway error is what the sweep's
    // operator needs to read.
    try {
      scope
        .resolve<{ error: (msg: string) => void }>('logger')
        .error(
          `[payments] deposit ${merchantTransactionId} submit outcome AMBIGUOUS ` +
            `(${(error as Error).message}) — left pending for the sweep`,
        );
    } catch {
      // Swallowed deliberately: the logger is the thing that failed. The row
      // stays 'pending', so the sweep still resolves this deposit whether or
      // not anyone ever reads about it.
    }
    throw error;
  }

  // A3Pay may ask the customer for a few cents more (or less) than we asked
  // for, to tell same-amount transfers apart (S$50 -> S$50.01). Re-lock the
  // row to what they will really pay, at the SAME rate, so every cent they
  // send is credited and the callback fence (settled == requested) still
  // holds exactly. Skipped when the new credit would cross the gateway's RM
  // ceiling: the row then keeps its original credit, as before.
  const nudged =
    fx !== null
      ? nudgedDeposit(
          fx,
          Number(result.depositActualAmount),
          GATEWAYS[gateway].payinNudgeCents,
        )
      : null;
  const relock =
    nudged !== null &&
    nudged.credit <= GATEWAYS[gateway].limits.depositMax &&
    topUpAmountError(nudged.credit, GATEWAYS[gateway].limits.depositMax) ===
      null
      ? nudged
      : null;
  await packs.updateGatewayDeposits({
    id: row.id,
    gateway_transaction_id: result.transactionId,
    ...(relock
      ? {
          gateway_amount: relock.gatewayAmount,
          amount_requested: relock.credit,
        }
      : {}),
  });

  return {
    url: result.url,
    transactionId: result.transactionId,
    merchantTransactionId,
    amount: relock?.credit ?? amount,
    bankCode: result.bankCode,
    accountNumber: result.accountNumber,
    accountHolderName: result.accountHolderName,
    referenceNo: result.referenceNo,
    qrCode: result.qrCode,
  };
}

// ---------------------------------------------------------------------------
// The settle half. ONE copy, shared by the callback route and the sweep.

/** The columns applyDepositOutcome reads. Deliberately narrower than the
 *  model: widening it is how a new dependency gets noticed. */
export type DepositOutcomeRow = {
  id: string;
  customer_id: string;
  merchant_transaction_id: string;
  gateway_transaction_id: string | null;
  amount_requested: unknown;
  payment_method_code: string;
  /** The status the caller READ. Every write below is claimed FROM it. */
  status: DepositStatus;
  gateway?: string | null;
};

export type DepositOutcome =
  | {
      state: 'settled';
      /**
       * WHERE this observation came from, which is what decides whether the
       * amount is fenced against the row. The two are not interchangeable:
       *
       * - `'callback'` — an unsolicited POST from the public internet. Its
       *   amount is attacker-influenced (only the signature says it came from
       *   the gateway, and a replayed or forged sum converts 1:1 into
       *   withdrawable balance), so it must EQUAL what the row asked for and
       *   sit under the gateway's ceiling, or nothing is written.
       * - `'requery'` — a server-initiated read of the gateway's own record,
       *   the provider's documented source of truth. It is trusted verbatim:
       *   the customer may genuinely have paid a different sum, and this is
       *   production's only crediting path, so refusing here strands the
       *   payment with no automatic remedy at all. Its ceiling guard lives
       *   upstream in `reconcileAction`, which quarantines before the sweep
       *   ever gets here.
       */
      source: 'callback' | 'requery';
      /** What the gateway says was paid. Credited verbatim (a `'callback'`
       *  is fenced against the row first). */
      amount: number;
      /** The reference the ledger row, the receipt and the feed row all
       *  carry. Composed by the caller, because the two of them know
       *  different things: the callback holds an id the row may not carry
       *  yet, the sweep holds only the row. */
      gatewayRef: string;
      /** Their id, when this observation learned one. Written to the row; an
       *  empty value is ignored rather than clearing what is already there. */
      gatewayTransactionId?: string | null;
      /** Each remaining field is written ONLY when the caller passes it —
       *  `null` is a value ("unknown"), `undefined` means "leave the column
       *  alone". The callback carries no fee and no bank references, and must
       *  not blank the ones the audit sweep backfills. */
      gatewayStatus?: number | null;
      netAmount?: number | null;
      bankReferenceNo?: string | null;
      uniqueReferenceNo?: string | null;
      settledAt: Date;
    }
  | {
      /** Close the row without touching the ledger. 'failed' is terminal;
       *  'expired' is not — see the model's `status` comment. */
      state: 'failed' | 'expired';
      gatewayTransactionId?: string | null;
    };

export type DepositOutcomeResult =
  /** `replayed` is the LEDGER's answer on a settle (the shared idempotency
   *  anchor is what decides whether money moved) and the ROW CLAIM's on a
   *  close (nothing else could answer). Both mean "this outcome was already
   *  applied", which is what the caller acts on. */
  | { applied: true; replayed: boolean }
  /** A money fence refused. NOTHING was written; the caller decides what to
   *  answer the gateway and how loudly to log. */
  | { applied: false; reason: 'amount-not-positive' | 'amount-mismatch' };

/**
 * Apply ONE observed outcome to ONE deposit row — the whole settle sequence,
 * in the order the callback route and the reconcile sweep both need it:
 *
 *   fence the amount -> credit (idempotent) -> receipt -> claim the row ->
 *   feed row (best-effort, and only when the credit was ours)
 *
 * Each caller used to carry its own copy. One copy does NOT mean one policy:
 * `outcome.source` keeps the per-site amount fence the two of them had for a
 * reason (see `DepositOutcome`). A callback's amount is attacker-influenced
 * and must match the row; a requery is the gateway's own authoritative record
 * and is credited verbatim, because the sweep is production's only crediting
 * path and refusing there strands a real payment with no automatic remedy.
 *
 * The receipt sits BEFORE the row claim and outside any replay guard — the
 * same ordering, for the same reason, as refundWithdrawal: once the
 * row leaves its current status nothing re-runs this branch, so a crash
 * between the claim and a later send would lose the email forever. A crash
 * after the send re-runs the whole sequence next sweep (the credit replays on
 * its anchor, the notification module's unique idempotency_key dedupes the
 * email).
 *
 * The rest of the ordering is load-bearing too: the credit commits first
 * because a settled row with no credit is invisible to every sweep, and the
 * claim is the LAST write because it is what makes the row invisible to them.
 */
export async function applyDepositOutcome(
  scope: { resolve: <T>(key: string) => T },
  deposit: DepositOutcomeRow,
  outcome: DepositOutcome,
): Promise<DepositOutcomeResult> {
  const packs = resolvePacks<GatewayDeposits>(scope);
  const gatewayTransactionId = outcome.gatewayTransactionId || null;
  const learnedId = gatewayTransactionId
    ? { gateway_transaction_id: gatewayTransactionId }
    : {};

  if (outcome.state !== 'settled') {
    const claimed = await packs.claimDepositStatus({
      id: deposit.id,
      from: [deposit.status],
      to: outcome.state,
      set: learnedId,
    });
    return { applied: true, replayed: !claimed };
  }

  const { amount } = outcome;
  // BOTH sources. Not the per-site fence below: a zero, negative or
  // unparseable amount is never a payment from anyone, and `Number(q.amount)`
  // on a malformed requery yields NaN, which slips past every `>` comparison
  // upstream and would otherwise be credited into a bigNumber column.
  if (!Number.isFinite(amount) || amount <= 0) {
    return { applied: false, reason: 'amount-not-positive' };
  }
  // CALLBACK ONLY. The hosted checkout fixes the sum at create-payment, so an
  // unsolicited callback can only disagree with the row if it is forged or the
  // gateway is wrong — and either way it must not become withdrawable balance.
  // Refuse and leave the row where it is; the sweep's requery then settles the
  // deposit on the gateway's own record. The gateway's own ceiling is the
  // second fence, read off the gateway the ROW was created under (the same
  // number as GATEWAY_MAX_RM today; the row's is the honest one to ask).
  //
  // A `'requery'` reaches neither fence — see `DepositOutcome.source` for why
  // trusting it is the deliberate choice, and `reconcileAction` for the
  // ceiling guard that still bounds it, upstream.
  //
  // Written as "not the trusted source" rather than "is the fenced source" so
  // it FAILS CLOSED: only the one value that has an argued reason to skip the
  // fence skips it. A typo at a boundary that casts (the specs' options
  // helper does), or a third source added later, is fenced by default rather
  // than silently credited verbatim.
  if (outcome.source !== 'requery') {
    const gateway = rowGateway(deposit);
    const ceiling = gateway
      ? GATEWAYS[gateway].limits.depositMax
      : GATEWAY_MAX_RM;
    if (amount !== Number(deposit.amount_requested) || amount > ceiling) {
      return { applied: false, reason: 'amount-mismatch' };
    }
  }

  const mutation = await packs.topUpCreditsWithLedger({
    customerId: deposit.customer_id,
    amount,
    reason: 'topup',
    ledgerPaymentMethod: deposit.payment_method_code,
    ledgerGatewayRef: outcome.gatewayRef,
    reference: outcome.gatewayRef,
    // The SAME anchor from both callers, so a callback and a sweep racing on
    // one deposit produce exactly one credit — whichever gets there first.
    idempotencyReference: topupIdempotencyReference(
      deposit.customer_id,
      deposit.merchant_transaction_id,
    ),
  });

  await sendTopupReceipt(scope, {
    customerId: deposit.customer_id,
    amount: mutation.amount,
    reference: outcome.gatewayRef,
    merchantTransactionId: deposit.merchant_transaction_id,
    paymentMethodCode: deposit.payment_method_code,
  });

  // Claimed FROM the status the caller read, not from a literal 'pending':
  // the callback's recovery branch and the sweep's second scan tier both
  // arrive with a written-off row, and a hardcoded 'pending' would match
  // nothing — leaving the credit committed while the row still said we had
  // given up on it.
  await packs.claimDepositStatus({
    id: deposit.id,
    from: [deposit.status],
    to: 'settled',
    set: {
      settled_at: outcome.settledAt,
      ...learnedId,
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
      // What the ledger holds: on a replay, the credit another caller wrote.
      amount_settled: mutation.amount,
      ...(outcome.netAmount !== undefined
        ? { net_amount: outcome.netAmount }
        : {}),
    },
  });

  if (!mutation.replayed) {
    try {
      await notifyFeed(scope, {
        receiverId: deposit.customer_id,
        template: 'topup_credited',
        data: { amount_myr: amount, reference: outcome.gatewayRef },
        idempotencyKey: topupFeedKey(deposit.merchant_transaction_id),
      });
    } catch {
      // Never fail a committed credit over a notification.
    }
  }

  return { applied: true, replayed: mutation.replayed };
}
