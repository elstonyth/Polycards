// The JSON bodies of GET /admin/payments/audit and POST .../audit/acknowledge,
// written once (ADR 0017). Types only. Gateway = source of truth for money in
// and out.
import type { PaymentGateway } from '../../../../modules/packs/gateway-types';

/** A gateway a ROW may name: a live one, or a retired one ('globepay') whose
 *  settled rows are still history on the audit panel. */
export type HistoricalGatewayId = PaymentGateway | (string & {});

export type GatewayAuditTotals = {
  count: number;
  gross: number;
  /** Σ net over rows whose net is known — a FLOOR when missing_net > 0. For a
   *  deposit that is what we RECEIVED (amount − fee); for a payout it is what
   *  the wallet PAID (amount + fee — TGPay charges payout fees on top). */
  net: number;
  missing_net: number;
  /** Settled deposits whose amount_settled is NULL (settled by hand) —
   *  `gross` is a FLOOR when > 0. Always 0 on the payout side. */
  missing_gross: number;
};

export type GatewayAuditFinding = {
  kind: 'deposit' | 'withdrawal';
  /** The gateway the row was created under — live or retired. */
  gateway: HistoricalGatewayId;
  id: string;
  merchant_transaction_id: string;
  gateway_transaction_id: string | null;
  customer_id: string;
  status: string;
  amount: number | null;
  note: string;
  audited_at: string | null;
  /** Who acknowledged this finding and when, while the note is still the one
   *  they acknowledged; null otherwise (a new note is a new warning). */
  acknowledged: {
    by: string | null;
    at: string | null;
    /** From the admin action log. */
    reason: string | null;
  } | null;
};

export type GatewayAudit = {
  currency: string;
  /** The rail's gateway (for RM: the active one). */
  gateway: HistoricalGatewayId;
  last_audited_at: string | null;
  /** Rows the gateway disagrees with. */
  findings_total: number;
  /** Rows from a retired gateway, which can never be checked again: listed,
   *  counted apart. */
  retired_total: number;
  /** Findings an operator acknowledged: listed last, never in findings_total. */
  acknowledged_total: number;
  totals: { deposits: GatewayAuditTotals; withdrawals: GatewayAuditTotals };
  /** Settled totals of every OTHER gateway that ever moved money. */
  history: ({ gateway: HistoricalGatewayId } & GatewayAudit['totals'])[];
  findings: GatewayAuditFinding[];
};

export type AcknowledgeResult = { acknowledged: true };
/** 409: the audit re-worded the finding since the page loaded. */
export type AcknowledgeConflict = { type: 'conflict'; message: string };
