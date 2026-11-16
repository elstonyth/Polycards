// The JSON bodies of GET/POST /admin/payments/gateway, written once
// (ADR 0017). Types only.
import type { PaymentGateway } from '../../../../modules/packs/gateway-types';

export type PaymentGatewaySetting = {
  /** What the backend is using right now. */
  active: PaymentGateway;
  /** The persisted admin choice; null = env default applies. */
  setting: string | null;
  env_default: PaymentGateway;
  gateways: { id: PaymentGateway; label: string; configured: boolean }[];
  /** One Settlement tab each: RM first, then every regional rail. */
  currencies: string[];
  /** POST only: non-blocking findings from the live check (e.g. an empty
   *  payout wallet). */
  warnings?: string[];
};

/** 422 from POST: the live check refused the switch; the operator may resend
 *  with force: true ("Switch anyway"). */
export type GatewayPreflightRefusal = {
  type: 'gateway_preflight_failed';
  message: string;
  problems: string[];
  warnings: string[];
  can_force: true;
};

export type { PaymentGateway };
