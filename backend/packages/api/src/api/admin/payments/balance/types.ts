// The JSON body of GET /admin/payments/balance, written once (ADR 0017).
// Types only.
import type { PaymentGateway } from '../../../../modules/packs/gateway-types';

export type GatewayBalance = {
  /** The rail asked for, and the gateway that serves it (for RM: the active
   *  one). */
  currency: string;
  gateway: PaymentGateway;
  label: string;
  enabled: boolean;
  balance: {
    currency_code: string;
    current: number;
    available: number;
    /** null when the gateway reports no T+1 figure (TGPay family). */
    t1: number | null;
    /** TGPay family: `current` is the pay-in wallet and `available` the
     *  separate payout wallet, not one wallet with part of it locked. */
    separate_wallets: boolean;
  } | null;
  /** The gateway answered but left a wallet out (shown as 0). */
  warning: string | null;
  /** The gateway could not be reached; balance is null. */
  error: string | null;
};
