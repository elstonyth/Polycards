/**
 * The active gateway's money bands, as the storefront sees them. Lives outside
 * the 'use server' action module because a server-action file may only export
 * async functions (the build refuses an exported object).
 */
export type PaymentLimits = {
  gateway: string;
  deposit: { minRm: number; maxRm: number };
  withdrawal: { minRm: number; maxRm: number };
};

/**
 * Used until the backend answers (and if it never does): TGPay's band
 * (RM 50–10,000 deposits, RM 50–30,000 payouts). Keep this the INTERSECTION
 * of every configured gateway's band — highest floor, lowest ceiling — so the
 * forms never offer an amount an active gateway would refuse.
 */
export const DEFAULT_PAYMENT_LIMITS: PaymentLimits = {
  gateway: 'unknown',
  deposit: { minRm: 50, maxRm: 10000 },
  withdrawal: { minRm: 50, maxRm: 30000 },
};
