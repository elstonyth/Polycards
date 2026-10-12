import { MedusaError } from '@medusajs/framework/utils';

// Currency conversion for gateways that settle in a currency other than our
// RM ledger (A3Pay: SGD). Pure — the rate row is injected — so every rounding
// rule is unit-testable.
//
// The model:
//   - `mid` is the market SGD->MYR rate (frankfurter, or an admin override);
//   - `markup` is an ABSOLUTE spread in RM per S$1, set by an admin;
//   - a DEPOSIT credits at `mid - markup` (S$100 at mid 3.30, markup 0.01 ->
//     RM 329.00), a PAYOUT pays at `mid + markup` (RM 331 -> S$100.00).
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

/** The fx_rate pair that prices SGD gateway traffic. */
export const SGD_MYR_PAIR = paymentFxPair('SGD');

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
 * it is a human decision, not a feed). ECB publishes on working days only, so
 * this has to clear a long weekend plus a failed fetch or two.
 */
export const PAYMENT_FX_MAX_AGE_MS = 4 * 24 * 60 * 60 * 1000;

/** Markup bounds the admin route enforces: 0 <= markup <= mid * this. */
export const PAYMENT_FX_MAX_MARKUP_SHARE = 0.2;

export type PaymentFxRow = {
  rate: unknown;
  fetched_at?: Date | string | null;
  manual_override?: boolean | null;
  manual_rate?: unknown;
  markup?: unknown;
};

export type PaymentFxQuote = {
  currency: string;
  /** RM per 1 unit of `currency`, before the spread. */
  mid: number;
  /** RM per 1 unit, absolute. */
  markup: number;
  /** RM credited per unit PAID IN. */
  depositRate: number;
  /** RM debited per unit PAID OUT. */
  payoutRate: number;
  source: 'manual' | 'feed';
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
  const mid = manual ?? positive(row.rate);
  if (!mid) return { error: `No usable ${currency} exchange rate.` };
  if (!manual) {
    const fetched = row.fetched_at ? new Date(row.fetched_at).getTime() : NaN;
    if (!Number.isFinite(fetched) || now - fetched > PAYMENT_FX_MAX_AGE_MS) {
      return { error: `The ${currency} exchange rate is out of date.` };
    }
  }
  const markup = Number(row.markup ?? 0);
  // A markup of 0 is refused, not quoted. The column defaults to 0, and a
  // rail that opens before an admin has set a spread trades SGD at the bare
  // ECB reference rate — which lags the market, so a customer who knows the
  // live rate can pick the direction it is wrong in. The rail stays paused
  // until a spread is set.
  if (!Number.isFinite(markup) || markup <= 0) {
    return { error: `No ${currency} markup is set.` };
  }
  if (markup > mid * PAYMENT_FX_MAX_MARKUP_SHARE) {
    return { error: `The ${currency} markup is out of range.` };
  }
  return {
    currency,
    mid,
    markup,
    depositRate: round6(mid - markup),
    payoutRate: round6(mid + markup),
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
): { min: number; max: number } {
  return {
    min: Math.max(
      currencyBand.depositMin,
      Math.ceil((ledgerBand.depositMin / quote.depositRate) * 100 - 1e-6) / 100,
    ),
    max: Math.min(
      currencyBand.depositMax,
      Math.floor((ledgerBand.depositMax / quote.depositRate) * 100 + 1e-6) /
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
 * How far above the locked amount a CALLBACK's reported payment may sit and
 * still settle at exactly the locked RM credit, in cents. A3Pay nudges an SGD
 * payin up a cent or so to keep same-amount transfers distinguishable
 * (payinActualAmount: 100 -> 100.01) and the customer pays the nudged sum;
 * that is still THIS deposit, at THIS quote. Never more than the locked RM is
 * credited this way — the nudge stays with us — and anything outside the
 * window is left to the amount fence (and the sweep's requery).
 */
export const PAYIN_NUDGE_CENTS = 10;

/**
 * The RM a deposit CALLBACK may be credited: the locked credit when the
 * reported payment is the locked amount or a small upward nudge of it, else
 * the proportional conversion (which the callback fence then compares).
 */
export function callbackLedgerAmount(row: RowFx, reported: number): number {
  const gateway = Number(row.gatewayAmount);
  if (
    row.gatewayAmount != null &&
    Number.isFinite(gateway) &&
    gateway > 0 &&
    Number.isFinite(reported)
  ) {
    const over = cents(reported) - cents(gateway);
    if (over >= 0 && over <= PAYIN_NUDGE_CENTS) {
      return cents(Number(row.ledgerAmount)) / 100;
    }
  }
  return toLedgerAmount(row, reported);
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
