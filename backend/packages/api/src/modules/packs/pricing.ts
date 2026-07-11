import { MedusaError } from '@medusajs/framework/utils';

export const DEFAULT_USD_MYR = 4.7;

// Fallback display margin over FMV when a Card row carries none (1.2 = +20%).
// The SINGLE source for the default - every quote/display call site and the
// Card model default use this, so quote == credit cannot drift if it changes.
export const DEFAULT_MARKET_MULTIPLIER = 1.2;
export const FX_USD_MYR_URL =
  process.env.FX_USD_MYR_URL ??
  'https://api.frankfurter.app/latest?from=USD&to=MYR';

export function displayMarketPrice(
  marketValueUsd: number,
  fxUsdMyr: number,
  multiplier: number,
): number {
  const raw = Number(marketValueUsd),
    fx = Number(fxUsdMyr),
    mult = Number(multiplier);
  if (
    ![raw, fx, mult].every(Number.isFinite) ||
    raw < 0 ||
    fx <= 0 ||
    mult <= 0
  )
    return 0;
  return Math.round(raw * fx * mult * 100) / 100;
}

export function effectiveRate(
  row: {
    rate: number;
    manual_override: boolean;
    manual_rate: number | null;
  } | null,
): number {
  if (!row) return DEFAULT_USD_MYR;
  if (row.manual_override) {
    const m = Number(row.manual_rate);
    if (Number.isFinite(m) && m > 0) return m;
  }
  const r = Number(row.rate);
  return Number.isFinite(r) && r > 0 ? r : DEFAULT_USD_MYR;
}

type FxRateSource = {
  listFxRates: (
    f: unknown,
    c: unknown,
  ) => Promise<
    Array<{
      rate: number;
      manual_override: boolean;
      manual_rate: number | null;
    }>
  >;
};

export type FxRateInfo = {
  rate: number;
  /**
   * true iff the rate came from a real FxRate row (fetched or valid manual
   * override) — the SAME condition under which the strict money resolver pays.
   * false means `rate` is the DEFAULT_USD_MYR display fallback: fine to show
   * a price, but a buyback quote derived from it must not be presented as a
   * firm offer, because the credit path will refuse (sim finding P1-1: the
   * reveal promised RM48.22 during an FX-empty window, then the sell 400'd).
   */
  firm: boolean;
};

// THE single FX resolution — every other resolver is a view of this one, so
// quote firmness and credit refusal can never diverge again. Row fields
// (rate/manual_rate) are bigNumber and can come back as strings/objects; the
// Number(...) + finite/>0 guards below normalize exactly like effectiveRate.
//
// Defensive on the DB read: callers (e.g. GET /admin/cards) Promise.all this
// alongside the card list, so a transient FxRate query failure must not 500
// the whole endpoint — it degrades to the default rate with firm:false.
export async function resolveFxRateInfo(packs: FxRateSource): Promise<FxRateInfo> {
  try {
    const [row] = await packs.listFxRates({ pair: 'USD_MYR' }, { take: 1 });
    if (row) {
      if (row.manual_override) {
        const m = Number(row.manual_rate);
        if (Number.isFinite(m) && m > 0) return { rate: m, firm: true };
      }
      const r = Number(row.rate);
      if (Number.isFinite(r) && r > 0) return { rate: r, firm: true };
    }
  } catch {
    // fall through to the display fallback
  }
  return { rate: DEFAULT_USD_MYR, firm: false };
}

// Lenient view for DISPLAY-ONLY call sites that don't quote a sell-back
// (catalog prices, admin lists): the rate, fallback tolerated.
export async function resolveFxRate(packs: FxRateSource): Promise<number> {
  return (await resolveFxRateInfo(packs)).rate;
}

// STRICT view for MONEY WRITES (buyback credits). Display routes tolerate
// the DEFAULT_USD_MYR fallback; a route that CREDITS money must not — a
// transient FX read failure would silently misprice the payout by the gap
// between 4.7 and the configured rate (audit 2026-07-07 M3). Refuse instead.
// Derived from resolveFxRateInfo so "strict pays" === "quote is firm".
export async function resolveFxRateStrict(packs: FxRateSource): Promise<number> {
  const { rate, firm } = await resolveFxRateInfo(packs);
  if (!firm) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'Exchange rate unavailable — please try again shortly.',
    );
  }
  return rate;
}

export async function fetchUsdMyr(
  url: string = FX_USD_MYR_URL,
): Promise<number> {
  const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const data = (await resp.json()) as { rates?: { MYR?: number } };
  const rate = data?.rates?.MYR;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0)
    throw new Error('FX feed: no usable USD->MYR');
  return rate;
}
