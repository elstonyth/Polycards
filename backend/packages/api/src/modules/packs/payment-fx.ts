import { MedusaError } from '@medusajs/framework/utils';

// Currency conversion for gateways that settle in a currency other than our
// RM ledger (A3Pay: SGD). Pure — the rate row is injected — so every rounding
// rule is unit-testable.
//
// The model:
//   - `mid` is the market SGD->MYR rate (the hourly feed, or an admin override);
//   - the FEE is a percent of the mid per direction, behind an admin on/off
//     switch (off = the bare mid both ways);
//   - a DEPOSIT credits at mid x (1 - top-up fee) (mid 3.19 at 0.5% ->
//     3.17405), a PAYOUT costs mid x (1 + withdrawal fee) (-> 3.20595).
// We keep the spread both ways. Every rounding is DOWN to the cent, in our
// favour, so the spread is never eaten by a half-cent.
//
// The quote is locked onto the deposit/withdrawal row when it is created
// (currency, gateway_amount, fx_mid, fx_markup). Everything after that —
// callback, sweep, audit — converts through the ROW, never through today's
// rate, so a rate move between creation and settlement cannot change what a
// customer is credited or paid.

/** Our ledger's currency (mirrors gateway.ts LEDGER_CURRENCY; this module
 *  stays import-free of the gateway registry). */
const LEDGER_CURRENCY_CODE = 'MYR';

/** The fx_rate pair that prices a gateway currency into RM (SGD -> SGD_MYR). */
export function paymentFxPair(currency: string): string {
  return `${currency}_MYR`;
}

/**
 * Per regional currency: where its mid rate comes from and the sane band an
 * admin's manual rate must sit in (RM per 1 unit). A currency with no `url`
 * is priced by an admin manual rate only. Adding a rail = one entry here +
 * its gateway in gateway.ts.
 */
export const PAYMENT_FX_FEEDS: Record<
  string,
  {
    url?: string;
    /** Tried when `url` fails or answers outside the band. */
    fallbackUrl?: string;
    /** The currency the fallback quotes FROM when it prices this one by
     *  proxy (USDT by USD). The feed must still say so, or it is refused. */
    fallbackQuotes?: string;
    min: number;
    max: number;
    unit: string;
  }
> = {
  // Hourly (sync-payment-fx.ts): Coinbase's public fiat rates move through
  // the day; ECB (frankfurter) publishes once per working day.
  SGD: {
    url:
      process.env.FX_SGD_MYR_URL ??
      'https://api.coinbase.com/v2/exchange-rates?currency=SGD',
    fallbackUrl: 'https://api.frankfurter.dev/v1/latest?from=SGD&to=MYR',
    min: 1,
    max: 10,
    unit: 'S$1',
  },
  // Coinbase quotes USDT itself, hourly. When it fails, USD->MYR (ECB) is the
  // proxy: USDT tracks the dollar, and the admin fee covers the gap. A manual
  // rate (which never ages out) overrides both if USDT ever trades off its
  // peg.
  USDT: {
    url:
      process.env.FX_USDT_MYR_URL ??
      'https://api.coinbase.com/v2/exchange-rates?currency=USDT',
    fallbackUrl: 'https://api.frankfurter.dev/v1/latest?from=USD&to=MYR',
    fallbackQuotes: 'USD',
    min: 2,
    max: 8,
    unit: '1 USDT',
  },
};

/**
 * Today's firm quote for a gateway currency, read fresh (uncached — this is a
 * money write). Throws the customer-facing refusal when there is none, so the
 * caller writes no row for a deposit or payout that cannot be priced.
 */
export async function loadPaymentFxQuote(
  packs: {
    listFxRates: (
      filter: { pair: string },
      config: { take: number },
    ) => Promise<PaymentFxRow[]>;
  },
  currency: string,
  now = Date.now(),
): Promise<PaymentFxQuote> {
  const [row] = await packs.listFxRates(
    { pair: paymentFxPair(currency) },
    { take: 1 },
  );
  const quote = paymentFxQuote(row ?? null, currency, now);
  if ('error' in quote) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `${currency} payments are paused right now — please try again shortly.`,
    );
  }
  return quote;
}

/**
 * A fetched rate older than this is not quoted (an admin override is exempt —
 * it is a human decision, not a feed). Age is measured from the ECB
 * publication DATE (sync-payment-fx.ts), and ECB skips TARGET holidays: over
 * Easter Thursday's rate is the newest until Tuesday afternoon (~5.6 days),
 * over Christmas ~4.6. Seven days clears both with a failed fetch to spare;
 * the admin fee is the cushion for the drift.
 */
export const PAYMENT_FX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The age limit for a LIVE feed (source 'coinbase', fetched hourly). Seven
 * days was sized for ECB's holidays; a live rate that old means every hourly
 * run has failed for days while the 0.5% fee is the only cushion. Six hours
 * rides out a few failed runs; when Coinbase stays down the job falls back to
 * ECB, whose rate is then aged by PAYMENT_FX_MAX_AGE_MS as before.
 */
export const PAYMENT_FX_LIVE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** The highest fee, in percent of the mid, either direction may carry. */
export const PAYMENT_FX_MAX_FEE_PERCENT = 20;

export type PaymentFxRow = {
  rate: unknown;
  /** Which feed wrote `rate` (sync-payment-fx.ts): 'coinbase' | 'frankfurter'. */
  source?: unknown;
  fetched_at?: Date | string | null;
  manual_override?: boolean | null;
  manual_rate?: unknown;
  /** null/undefined = never configured: the rail stays paused. */
  fee_enabled?: boolean | null;
  deposit_fee_percent?: unknown;
  payout_fee_percent?: unknown;
};

export type PaymentFxQuote = {
  currency: string;
  /** RM per 1 unit of `currency`, before the fee. */
  mid: number;
  /** Is the fee switched on? Off = both rates are the mid. */
  feeEnabled: boolean;
  /** The fee each way, in percent of the mid (0 while switched off). */
  depositFeePercent: number;
  payoutFeePercent: number;
  /** RM per 1 unit the fee takes, as locked on each row: mid - depositRate
   *  on a top-up, payoutRate - mid on a payout. */
  depositMarkup: number;
  payoutMarkup: number;
  /** RM credited per unit PAID IN. */
  depositRate: number;
  /** RM debited per unit PAID OUT. */
  payoutRate: number;
  source: 'manual' | 'feed';
};

/** A fee percentage as stored, or null when it is not a usable one. */
const feePercent = (value: unknown): number | null => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 && n <= PAYMENT_FX_MAX_FEE_PERCENT
    ? n
    : null;
};

const positive = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The firm quote for a rate row, or the reason there is none. No fallback
 * rate exists on purpose: crediting real money at a made-up rate is worse than
 * saying "SGD top-ups are paused".
 */
export function paymentFxQuote(
  row: PaymentFxRow | null | undefined,
  currency: string,
  now = Date.now(),
): PaymentFxQuote | { error: string } {
  if (!row) return { error: `No ${currency} exchange rate is set.` };
  const manual = row.manual_override ? positive(row.manual_rate) : null;
  // A pin the admin set on purpose is never silently swapped for the feed.
  if (row.manual_override && !manual) {
    return { error: `The pinned ${currency} exchange rate is not usable.` };
  }
  const mid = manual ?? positive(row.rate);
  if (!mid) return { error: `No usable ${currency} exchange rate.` };
  if (!manual) {
    const fetched = row.fetched_at ? new Date(row.fetched_at).getTime() : NaN;
    const maxAge =
      row.source === 'coinbase'
        ? PAYMENT_FX_LIVE_MAX_AGE_MS
        : PAYMENT_FX_MAX_AGE_MS;
    if (!Number.isFinite(fetched) || now - fetched > maxAge) {
      return { error: `The ${currency} exchange rate is out of date.` };
    }
  }
  // A rail an admin has never configured is refused, not quoted: opening it
  // at the bare mid by default would trade before anyone decided to. Once
  // saved, the switch decides — off quotes the mid both ways on purpose.
  if (row.fee_enabled == null) {
    return { error: `No ${currency} fee is set.` };
  }
  const feeEnabled = row.fee_enabled === true;
  const depositFeePercent = feeEnabled
    ? feePercent(row.deposit_fee_percent)
    : 0;
  const payoutFeePercent = feeEnabled ? feePercent(row.payout_fee_percent) : 0;
  if (depositFeePercent === null || payoutFeePercent === null) {
    return { error: `The ${currency} fee is out of range.` };
  }
  // Operator's rule (2026-10-13): market 3.19 with 0.5% each way credits a
  // top-up at 3.19 x 99.5% and debits a payout at 3.19 x 100.5%.
  const depositRate = round6(mid * (1 - depositFeePercent / 100));
  const payoutRate = round6(mid * (1 + payoutFeePercent / 100));
  return {
    currency,
    mid,
    feeEnabled,
    depositFeePercent,
    payoutFeePercent,
    depositMarkup: round6(mid - depositRate),
    payoutMarkup: round6(payoutRate - mid),
    depositRate,
    payoutRate,
    source: manual ? 'manual' : 'feed',
  };
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
const cents = (amount: number): number => Math.round(amount * 100);

/** RM credited for `gatewayAmount` paid in — rounded DOWN to the cent. */
export function creditForDeposit(
  gatewayAmount: number,
  quote: Pick<PaymentFxQuote, 'depositRate'>,
): number {
  // Integer cents times the rate; the epsilon absorbs float noise such as
  // 329.00000000000006 only ever in the customer's favour by < 1e-6 cent.
  return Math.floor(cents(gatewayAmount) * quote.depositRate + 1e-6) / 100;
}

/** Gateway-currency amount paid out for `rmAmount` debited — DOWN to the cent. */
export function payoutForWithdrawal(
  rmAmount: number,
  quote: Pick<PaymentFxQuote, 'payoutRate'>,
): number {
  return Math.floor(cents(rmAmount) / quote.payoutRate + 1e-6) / 100;
}

/**
 * The S$ band a top-up may take TODAY: the gateway's own S$ band, narrowed so
 * the converted RM credit also sits inside the RM band (min rounded up, max
 * rounded down to the cent). S$3,000 at 3.40 would otherwise pass the S$
 * check and fail the RM ceiling with an RM-worded refusal.
 */
export function regionalDepositBand(
  quote: Pick<PaymentFxQuote, 'depositRate'>,
  currencyBand: { depositMin: number; depositMax: number },
  ledgerBand: { depositMin: number; depositMax: number },
  windowCents: number = PAYIN_NUDGE_CENTS,
): { min: number; max: number } {
  return {
    min: Math.max(
      currencyBand.depositMin,
      Math.ceil((ledgerBand.depositMin / quote.depositRate) * 100 - 1e-6) / 100,
    ),
    // Less the nudge the gateway may add (its payinNudgeCents), so the
    // nudged sum still credits inside the RM band and the row re-locks.
    max: Math.min(
      currencyBand.depositMax,
      (Math.floor((ledgerBand.depositMax / quote.depositRate) * 100 + 1e-6) -
        windowCents) /
        100,
    ),
  };
}

/**
 * The RM band a payout to a regional bank may take TODAY: the RM band,
 * narrowed so the S$ it converts to (floored to the cent, as
 * payoutForWithdrawal does) sits inside the gateway's own S$ band. The form
 * enters RM, so this is the band it can check before the customer taps; at
 * 3.2017, S$30 needs RM 96.05, not the RM band's RM 50.
 */
export function regionalWithdrawalBand(
  quote: Pick<PaymentFxQuote, 'payoutRate'>,
  currencyBand: { withdrawalMin: number; withdrawalMax: number },
  ledgerBand: { withdrawalMin: number; withdrawalMax: number },
): { min: number; max: number } {
  let min =
    Math.ceil(currencyBand.withdrawalMin * quote.payoutRate * 100 - 1e-6) /
    100;
  // The payout floors to the cent, so the rounded-up RM can still land a
  // cent short of the S$ floor; one more cent always clears it.
  if (payoutForWithdrawal(min, quote) < currencyBand.withdrawalMin) {
    min = (cents(min) + 1) / 100;
  }
  return {
    min: Math.max(ledgerBand.withdrawalMin, min),
    max: Math.min(
      ledgerBand.withdrawalMax,
      Math.floor(currencyBand.withdrawalMax * quote.payoutRate * 100 + 1e-6) /
        100,
    ),
  };
}

/**
 * The FX lock a row carries. A row in a non-RM `currency` MUST carry its
 * locked gateway amount; an RM row (or a row from before the lock existed,
 * `currency` absent) converts 1:1.
 */
export type RowFx = {
  /** RM: amount_requested on a deposit, amount on a withdrawal. */
  ledgerAmount: unknown;
  gatewayAmount: unknown;
  /** The row's gateway currency; absent/'MYR' = an RM row. */
  currency?: unknown;
};

/**
 * Convert an amount the GATEWAY reported (in its own currency) into RM through
 * the row's lock: proportional to the locked pair, so the reported amount equal
 * to the locked gateway amount maps to EXACTLY the locked RM amount — no
 * re-rounding drift between quote time and settle time — and a different
 * reported amount (a 100 -> 100.01 uniqueness nudge, a partial payment) scales
 * at the same locked rate. NaN in, NaN out: the money fences refuse NaN.
 */
export function toLedgerAmount(row: RowFx, reported: number): number {
  const gateway = Number(row.gatewayAmount);
  if (row.gatewayAmount == null || !Number.isFinite(gateway) || gateway <= 0) {
    // No lock. Fine for an RM row; for a row in another currency it would
    // credit S$ figures as RM, so it is NaN — every money fence refuses NaN.
    const rm = row.currency == null || row.currency === LEDGER_CURRENCY_CODE;
    return rm ? reported : NaN;
  }
  if (!Number.isFinite(reported)) return NaN;
  const ledgerCents = cents(Number(row.ledgerAmount));
  return (
    Math.floor((ledgerCents * cents(reported)) / cents(gateway) + 1e-6) / 100
  );
}

/**
 * How far A3Pay may move a payin from the amount we asked for, in cents. It
 * nudges an SGD payin by a cent or so to keep same-amount transfers
 * distinguishable (payinActualAmount: 50 -> 50.01) and the customer pays the
 * nudged sum. startDeposit re-locks the row to that sum at the same rate
 * (nudgedDeposit), so the customer is credited for every cent they send. A
 * CALLBACK inside this window settles at exactly the row's locked RM credit
 * (a row the re-lock missed keeps its original credit); anything outside it
 * is left to the amount fence (and the sweep's requery). A gateway may set
 * its own window (GATEWAYS[id].payinNudgeCents); this is the default.
 */
export const PAYIN_NUDGE_CENTS = 10;

/**
 * The row's new lock when the gateway asks the customer for `actual` instead
 * of the locked amount: the same rate, applied to what they will really pay.
 * Null = keep the lock (no change, not a number, or further off than a nudge).
 */
export function nudgedDeposit(
  lock: { gatewayAmount: number; mid: number; markup: number },
  actual: number,
  windowCents: number = PAYIN_NUDGE_CENTS,
): { gatewayAmount: number; credit: number } | null {
  if (!Number.isFinite(actual) || actual <= 0) return null;
  const moved = cents(actual) - cents(lock.gatewayAmount);
  if (moved === 0 || Math.abs(moved) > windowCents) return null;
  const gatewayAmount = cents(actual) / 100;
  return {
    gatewayAmount,
    credit: creditForDeposit(gatewayAmount, {
      depositRate: round6(lock.mid - lock.markup),
    }),
  };
}

/**
 * The RM a deposit CALLBACK may be credited: the locked credit when the
 * reported payment is the locked amount or a small upward nudge of it, else
 * the proportional conversion (which the callback fence then compares).
 */
export function callbackLedgerAmount(
  row: RowFx,
  reported: number,
  windowCents: number = PAYIN_NUDGE_CENTS,
): number {
  const gateway = Number(row.gatewayAmount);
  if (
    row.gatewayAmount != null &&
    Number.isFinite(gateway) &&
    gateway > 0 &&
    Number.isFinite(reported)
  ) {
    const over = cents(reported) - cents(gateway);
    if (over >= 0 && over <= windowCents) {
      return cents(Number(row.ledgerAmount)) / 100;
    }
  }
  return toLedgerAmount(row, reported);
}

/**
 * True when a row locked in another currency is reported paid more than a
 * nudge away from its locked gateway amount. A3Pay matches a payin ONLY by its
 * exact nudged sum, so such a report is a slip at their end (a manual match),
 * never a customer who paid a different amount. RM rows and unreadable
 * amounts are false here: the existing money fences handle those.
 */
export function offLock(
  row: RowFx,
  reported: number,
  windowCents: number = PAYIN_NUDGE_CENTS,
): boolean {
  if (row.currency == null || row.currency === LEDGER_CURRENCY_CODE) {
    return false;
  }
  const locked = Number(row.gatewayAmount);
  if (row.gatewayAmount == null || !Number.isFinite(locked)) return false;
  if (!Number.isFinite(reported)) return false;
  return Math.abs(cents(reported) - cents(locked)) > windowCents;
}

/** The identity lock, for an RM row. */
export const NO_FX: RowFx = { ledgerAmount: null, gatewayAmount: null };

/** A row's lock from its columns. */
export function rowFx(row: {
  amount_requested?: unknown;
  amount?: unknown;
  gateway_amount?: unknown;
  currency?: unknown;
}): RowFx {
  return {
    ledgerAmount: row.amount_requested ?? row.amount,
    gatewayAmount: row.gateway_amount ?? null,
    currency: row.currency ?? null,
  };
}
