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

/** The GlobePay production band, used until the backend answers (and if it
 *  never does): the sheet must never offer a floor the gateway will refuse. */
export const DEFAULT_PAYMENT_LIMITS: PaymentLimits = {
  gateway: 'unknown',
  deposit: { minRm: 30, maxRm: 10000 },
  withdrawal: { minRm: 50, maxRm: 50000 },
};
