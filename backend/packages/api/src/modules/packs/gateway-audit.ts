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
/** A row with an open finding is re-audited this often instead, at any age:
 *  a refunded payout the gateway still holds may yet be paid twice
 *  (2026-10-14), and the Settlement page should follow within the hour. */
export const GATEWAY_AUDIT_FINDING_REPEAT_MS = 60 * 60 * 1000;
/** Of each batch, at most this many go to open findings. Some never clear
 *  (a rounding gap the gateway will always report), and a batch they could
 *  fill would starve new rows of their first check again (#776). */
export const GATEWAY_AUDIT_FINDING_BATCH = 10;
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

/** What the ledger already holds for a row: its own idempotency anchor, or a
 *  hand adjustment that names it. A note about money owed is only true once
 *  this has been read. */
export type LedgerTrail = { anchored: boolean; hand: boolean };

/**
 * Read the ledger for one row. `refs` are the row's own references; a hand
 * credit has no link to a row, so naming one in its reason is the only trail it
 * leaves (shortcut: an adjustment that names neither is invisible here; the
 * Credit deposit action exists so staff need not write one).
 */
export async function ledgerTrail(
  packs: {
    listCreditTransactions(
      filter: { customer_id: string },
      config: { take?: number; select?: 'reference'[] },
    ): Promise<{ reference?: string | null }[]>;
  },
  input: { customerId: string; anchor: string; refs: (string | null)[] },
): Promise<LedgerTrail> {
  const customer_id = input.customerId;
  const [anchored] = await packs.listCreditTransactions(
    { customer_id, source_transaction_id: input.anchor } as { customer_id: string },
    { take: 1 },
  );
  const adjustments = await packs.listCreditTransactions(
    { customer_id, reason: ['adjustment', 'bonus_grant'] } as {
      customer_id: string;
    },
    { select: ['reference'] },
  );
  const refs = input.refs.filter((r): r is string => Boolean(r));
  return {
    anchored: Boolean(anchored),
    hand: adjustments.some((a) =>
      refs.some((ref) => a.reference?.includes(ref)),
    ),
  };
}

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
 * Wording is for the admin page, so it says what the operator must do. `ledger`
 * is read only once there is a note to write (ledgerTrail).
 */
export function depositAuditNote(
  row: AuditedRow,
  gateway: GatewayAnswer,
  ledger?: LedgerTrail,
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
    const head = `gateway says PAID (${amount.toFixed(2)}) but the row is ${row.status}`;
    if (ledger?.anchored) {
      return `${head} — its credit is already on the ledger, do not credit again`;
    }
    if (ledger?.hand) {
      return `${head} — a hand adjustment names this deposit, do not credit again`;
    }
    return ledger
      ? `${head} — customer paid and was not credited. Use Credit deposit on Settlement, never a hand adjustment`
      : `${head} — customer paid and was not credited`;
  }
  // An expired top-up the gateway still shows pending was simply never paid:
  // the gateway does not close abandoned orders. If the customer pays later,
  // the re-check above reports PAID.
  if (state === 'pending' && row.status !== 'expired') {
    return `gateway still reports pending for a row we marked ${row.status}`;
  }
  return null;
}

export function withdrawalAuditNote(
  row: AuditedRow,
  gateway: GatewayAnswer,
  ledger?: LedgerTrail,
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
      const head = 'gateway says the payout FAILED but the row is settled';
      if (ledger?.anchored) {
        return `${head} — its refund is already on the ledger, do not refund again`;
      }
      if (ledger?.hand) {
        return `${head} — a hand adjustment names this payout, do not refund again`;
      }
      return `${head} — customer was not refunded, investigate`;
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

// The fields to write for a new audit note, used by every writer of
// audit_note: the audit job and the TGPay-family and A3Pay payout callbacks.
// An operator's acknowledgement (Settlement, 2026-10-15) is dropped when the
// note it covered is not the one being written, so a new answer from the
// gateway, agreement included, comes back unacknowledged.
export function stampNote(
  row: { audit_ack_note?: string | null },
  note: string | null,
): Record<string, unknown> {
  return row.audit_ack_note != null && row.audit_ack_note !== note
    ? {
        audit_note: note,
        audit_ack_note: null,
        audit_ack_by: null,
        audit_ack_at: null,
      }
    : { audit_note: note };
}
