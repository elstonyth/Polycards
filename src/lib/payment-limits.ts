/**
 * The active gateway's money bands, as the storefront sees them. Lives outside
 * the 'use server' action module because a server-action file may only export
 * async functions (the build refuses an exported object).
 */
/**
 * A regional rail beside the active gateway (A3Pay: Singapore, SGD). Its
 * bands are in ITS currency; `rate` is RM per 1 unit — credited on a top-up,
 * debited on a payout — or null when the backend has no firm rate (then the
 * rail is reported closed).
 */
export type RegionalRail = {
  gateway: string;
  currency: string;
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
  deposit: { min: number | null; max: number | null };
  withdrawal: { min: number | null; max: number | null };
  /** The RM a payout through this rail may take today (its RM band narrowed
   *  to the S$ band at today's rate); absent from an older backend. */
  withdrawalRm?: { minRm: number; maxRm: number };
  rate: { deposit: number; payout: number } | null;
};

/** RM credited for `paid` in a regional currency — floored to the cent,
 *  exactly as the backend quotes it (payment-fx.ts creditForDeposit). */
export function regionalCredit(paid: number, depositRate: number): number {
  return Math.floor(Math.round(paid * 100) * depositRate + 1e-6) / 100;
}

/** Regional currency paid out for an RM debit — floored to the cent, as the
 *  backend quotes it (payment-fx.ts payoutForWithdrawal). */
export function regionalPayout(rmAmount: number, payoutRate: number): number {
  return Math.floor(Math.round(rmAmount * 100) / payoutRate + 1e-6) / 100;
}

export type PaymentLimits = {
  regional?: RegionalRail[];
  gateway: string;
  deposit: { minRm: number; maxRm: number };
  withdrawal: { minRm: number; maxRm: number };
  depositsEnabled: boolean;
  withdrawalsEnabled: boolean;
  /** ISO instant a timed withdrawal pause ends; absent when there is none. */
  withdrawalsPausedUntil?: string | null;
};

/**
 * Used until the backend answers (and if it never does): TGPay's band
 * (RM 50–10,000 deposits, RM 50–30,000 payouts). Keep this the INTERSECTION
 * of every configured gateway's band — highest floor, lowest ceiling — so the
 * forms never offer an amount an active gateway would refuse. Both channels
 * default OPEN: the until-it-answers value must never close a channel.
 */
export const DEFAULT_PAYMENT_LIMITS: PaymentLimits = {
  gateway: 'unknown',
  deposit: { minRm: 50, maxRm: 10000 },
  withdrawal: { minRm: 50, maxRm: 30000 },
  depositsEnabled: true,
  withdrawalsEnabled: true,
};
