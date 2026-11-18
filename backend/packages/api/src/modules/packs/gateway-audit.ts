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
  /** Deposits only: amount_requested, what the row asked for. */
  requested?: number | null;
};

export const SETTLED_BUT_FAILED_NOTE =
  'gateway says FAILED but the row is settled — credit issued without gateway confirmation, investigate';

const SHORT_CREDIT_PREFIX = 'gateway says FAILED, and the row was credited ';

/**
 * A settled row credited less than it asked, on a gateway that says FAILED.
 * The usual cause is a short payment credited by hand for what arrived: the
 * gateway will not approve a different amount, so it keeps the order FAILED
 * and books the arrived sum under its own reference (four USDT top-ups,
 * 2026-10-26 to 11-08). It is not the only cause: a requery credits the
 * gateway's figure verbatim, so a bank gateway can settle short on its own and
 * later turn FAILED. The audit sees neither the manual entry nor who credited
 * the row, so the note names the check and keeps "investigate" for when the
 * check fails. It stays a finding either way.
 */
export function shortCreditNote(credited: number, requested: number): string {
  return `${SHORT_CREDIT_PREFIX}RM ${credited.toFixed(2)} of RM ${requested.toFixed(2)} asked, so the customer paid short. If the amount that arrived was credited by hand, confirm the gateway holds a manual entry for it, then acknowledge. With no such entry, investigate`;
}

const creditedShort = (
  row: AuditedRow,
): row is AuditedRow & {
  amount: number;
  requested: number;
} =>
  row.amount !== null &&
  Number.isFinite(row.amount) &&
  row.requested != null &&
  Number.isFinite(row.requested) &&
  row.requested - row.amount >= 0.005;

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
    { customer_id, source_transaction_id: input.anchor } as {
      customer_id: string;
    },
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
      return creditedShort(row)
        ? shortCreditNote(row.amount, row.requested)
        : SETTLED_BUT_FAILED_NOTE;
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

/**
 * A settled row the gateway FAILED, linked (gateway_adjustment_ref) to the
 * gateway's manual entry for what actually arrived: the order stays FAILED by
 * the gateway's rule, so the entry is what backs the hand credit. Agreement
 * needs the entry PAID for exactly what the row credited; anything else names
 * the entry. `entry` is the gateway's answer for the ENTRY's reference.
 */
export function adjustmentAuditNote(
  row: AuditedRow,
  ref: string,
  entry: GatewayAnswer,
): string | null {
  if (entry.kind === 'not-found') {
    return `gateway has NO record of manual entry ${ref} linked to this settled deposit — investigate`;
  }
  const { state, amount } = entry;
  if (state === 'success') {
    // Unlike the order check, an unreadable figure is NOT agreement here: the
    // entry is the only evidence for the credit, so it must show the money.
    if (!Number.isFinite(amount)) {
      return `gateway's manual entry ${ref} reports no readable amount — investigate`;
    }
    return row.amount !== null && sameMoney(row.amount, amount)
      ? null
      : `gateway's manual entry ${ref} paid ${amount.toFixed(2)}, row credited ${rowMoney(row.amount)} — investigate`;
  }
  return `gateway's manual entry ${ref} is ${
    state === 'failed' ? 'FAILED' : 'still pending'
  }, but the row is settled — investigate`;
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
// gateway, agreement included, comes back unacknowledged. One exception: the
// settled-but-FAILED alarm softened to a short-payment note is the same answer
// from the gateway in calmer words, so its acknowledgement carries over.
export function stampNote(
  row: { audit_note?: string | null; audit_ack_note?: string | null },
  note: string | null,
): Record<string, unknown> {
  if (
    row.audit_ack_note === SETTLED_BUT_FAILED_NOTE &&
    row.audit_note === SETTLED_BUT_FAILED_NOTE &&
    note?.startsWith(SHORT_CREDIT_PREFIX)
  ) {
    return { audit_note: note, audit_ack_note: note };
  }
  return row.audit_ack_note != null && row.audit_ack_note !== note
    ? {
        audit_note: note,
        audit_ack_note: null,
        audit_ack_by: null,
        audit_ack_at: null,
      }
    : { audit_note: note };
}
