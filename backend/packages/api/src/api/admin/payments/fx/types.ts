// The JSON body of GET/POST /admin/payments/fx (POST answers with the GET),
// written once (ADR 0017). Types only.
import type { PaymentFxQuote } from '../../../../modules/packs/payment-fx';

export type PaymentFxState = {
  currency: string;
  pair: string;
  /** "1 SGD"-style label for one unit. */
  unit: string;
  /** Sane band for a manual rate (RM per unit); null = unbounded. */
  manual_band: { min: number | null; max: number | null };
  feed_rate: number | null;
  source: string | null;
  fetched_at: string | null;
  manual_override: boolean;
  manual_rate: number | null;
  /** null = never configured: the rail stays paused until saved once. */
  fee_enabled: boolean | null;
  /** Percent of the mid; kept while the fee is switched off. */
  deposit_fee_percent: number;
  payout_fee_percent: number;
  max_fee_percent: number;
  quote: PaymentFxQuote | null;
  quote_error: string | null;
  earnings: {
    deposits: { count: number; rm: number };
    payouts: { count: number; rm: number };
    total_rm: number;
  };
};

export type { PaymentFxQuote };
