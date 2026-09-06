import type { SettlementState } from './gateway-types';

// Gateway audit (plan 130): the gateway is the source of truth for money in
// and out, so rows we consider FINAL are re-read against it on a schedule and
// any disagreement is recorded on the row (audit_note) for the operator. Pure
// verdict logic here; the sweep in src/jobs/gateway-audit.ts does the I/O.
//
// This is deliberately separate from the reconcile sweeps, which only chase
// PENDING rows and are allowed to move money. The audit never moves money: it
// only writes what the gateway said next to what we did.

/** How far back the audit re-reads final rows. */
export const GATEWAY_AUDIT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** A row is re-audited once this much time has passed since its last audit. */
export const GATEWAY_AUDIT_REPEAT_MS = 24 * 60 * 60 * 1000;
/** Rows per kind per run — one gateway call each. */
export const GATEWAY_AUDIT_BATCH = 50;

export type AuditedRow = {
  status: string;
  /** What we recorded: amount_settled for deposits, amount for withdrawals. */
  amount: number | null;
};

export type GatewayAnswer =
  | { kind: 'detail'; state: SettlementState; amount: number }
  | { kind: 'not-found' };

/**
 * Amounts agree when both are known and equal to the cent. A gateway that
 * reports no amount (NaN) cannot contradict ours — the STATE still can — so
 * an unreadable figure is treated as agreement, never as a mismatch.
 */
const sameMoney = (a: number | null, b: number): boolean =>
  !Number.isFinite(b) ||
  (a !== null && Number.isFinite(a) && Math.abs(a - b) < 0.005);

/**
 * What, if anything, the gateway disagrees with. `null` means agreement.
 * Wording is for the admin page, so it says what the operator must do.
 */
export function depositAuditNote(
  row: AuditedRow,
  gateway: GatewayAnswer,
): string | null {
  if (gateway.kind === 'not-found') {
    return row.status === 'settled'
      ? 'gateway has NO record of this settled deposit — verify the credit by hand'
      : null;
  }
  const { state, amount } = gateway;
  if (row.status === 'settled') {
    if (state === 'success') {
      return sameMoney(row.amount, amount)
        ? null
        : `gateway paid ${amount.toFixed(2)}, row credited ${rowMoney(row.amount)}`;
    }
    if (state === 'failed') {
      return 'gateway says FAILED but the row is settled — credit issued without gateway confirmation, investigate';
    }
    return 'gateway still reports pending for a row we settled';
  }
  // failed / expired
  if (state === 'success') {
    return `gateway says PAID (${amount.toFixed(2)}) but the row is ${row.status} — customer paid and was not credited`;
  }
  if (state === 'pending') {
    return `gateway still reports pending for a row we marked ${row.status}`;
  }
  return null;
}

export function withdrawalAuditNote(
  row: AuditedRow,
  gateway: GatewayAnswer,
): string | null {
  if (gateway.kind === 'not-found') {
    return row.status === 'settled'
      ? 'gateway has NO record of this settled payout — verify the bank transfer by hand'
      : null;
  }
  const { state, amount } = gateway;
  if (row.status === 'settled') {
    if (state === 'success') {
      return sameMoney(row.amount, amount)
        ? null
        : `gateway paid out ${amount.toFixed(2)}, row debited ${rowMoney(row.amount)}`;
    }
    if (state === 'failed') {
      return 'gateway says the payout FAILED but the row is settled — customer was not refunded, investigate';
    }
    return 'gateway still reports pending for a payout we marked settled';
  }
  // failed (refunded)
  if (state === 'success') {
    return `gateway says PAID OUT (${amount.toFixed(2)}) but the row is failed and refunded — DOUBLE PAYMENT risk, investigate now`;
  }
  if (state === 'pending') {
    return 'gateway still reports pending for a payout we refunded';
  }
  return null;
}

/** Our side of a disagreement: an absent amount reads as absent, never as 0.00. */
function rowMoney(amount: number | null): string {
  return amount === null
    ? 'nothing (row records no amount)'
    : amount.toFixed(2);
}
