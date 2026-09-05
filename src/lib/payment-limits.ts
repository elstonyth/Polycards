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
 * Used until the backend answers (and if it never does). The INTERSECTION of
 * the gateways' bands — highest floor, lowest ceiling (GlobePay RM 30–10,000 /
 * RM 50–50,000; TGPay RM 50–10,000 / RM 50–30,000) — so the forms never offer
 * an amount some active gateway would refuse. A fetch failure therefore costs
 * a GlobePay customer RM 30–49 top-ups and RM 30,001–50,000 payouts until the
 * next open, never a refused submit.
 */
export const DEFAULT_PAYMENT_LIMITS: PaymentLimits = {
  gateway: 'unknown',
  deposit: { minRm: 50, maxRm: 10000 },
  withdrawal: { minRm: 50, maxRm: 30000 },
};
