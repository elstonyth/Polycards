import { useQuery } from '@tanstack/react-query';
import { getPaymentFx } from '../../lib/admin-rest';

// A regional rail's conversion (A3Pay: SGD): the market rate into RM and OUR
// fee on it, a percent of the market rate each way behind an on/off switch.
// Customers pay and are paid in that currency; the ledger stays in RM. A
// top-up credits at market x (1 - top-up fee), a payout costs market x
// (1 + withdrawal fee); the difference is what the conversion earns. Fee off
// = both at the market rate. Every payment locks the rate it was quoted at,
// so a change only affects payments started AFTER it is saved.

export const fxKey = (currency: string) => ['payment-fx', currency] as const;

export const usePaymentFx = (currency: string) =>
  useQuery({
    queryKey: fxKey(currency),
    queryFn: () => getPaymentFx(currency),
  });

export const fmtRate = (n: number, dp = 4) => n.toFixed(dp);
export const floorCents = (n: number) => Math.floor(n * 100 + 1e-6) / 100;
// Mirrors payment-fx.ts round6, so the preview shows the rate a save quotes.
export const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
