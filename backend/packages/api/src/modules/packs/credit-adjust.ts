// Manual credit adjustment rules (operator grant / refund / clawback). Pure
// functions so the workflow step stays a thin orchestrator and the rules are
// unit-testable without a container. Mirrors topup.ts — same epsilon cent
// check, but signed amounts: positive grants, negative deducts.

// Per-call magnitude ceiling. Raised from 10_000 so support can settle
// high-value cases in one row instead of splitting them. This is NOT a
// typo guard any more — at this size a slipped digit mints real money, so
// the confirm Prompt in the admin UI is the only thing between an operator
// and a six-figure grant. Every adjustment is audited (note + ledger row).
export const ADJUST_MAX_RM = 1_000_000;

export const ADJUST_NOTE_MAX = 512;

// Rolling-24h GLOBAL ceiling on MINTED credit. ADJUST_MAX_RM bounds ONE call;
// this bounds the DAY, across every admin and every customer.
//
// Why a second, aggregate bound: the per-call ceiling above is enforced only
// per row, and the shared admin-action limiter allows ~200 calls/min per actor,
// so the per-call ceiling alone permits ~RM 200,000,000/min of minted credit
// from a single compromised token. Minted credit is stamped
// external_funded_cents = 0 — it banks zero playthrough, so on an account with
// no unplayed deposits it is immediately withdrawable. The admin_action_audit
// row is written after the fact: forensics, not a control.
//
// Default equals the per-call ceiling, so one max-size grant per day still
// passes and a SECOND same-day max grant trips it.
export const ADJUST_DAILY_MINT_MAX_RM_DEFAULT = 1_000_000;

// Refusal rule for the rolling-24h mint ceiling. Pure so the boundary
// arithmetic is unit-testable without a container or a database.
//
// Deliberately positive-only: a clawback (negative adjustment) is never
// blocked and never counts toward the window. Netting them in would let an
// operator buy back headroom by deducting from one customer to mint to
// another, which is exactly the move this bounds.
//
// The message names the env var and the window total but NEVER a customer id:
// this is a global figure surfaced in admin UI and logs that are not
// customer-scoped, so naming an account here would leak one.
export function adjustDailyMintError(
  windowCents: number,
  amountCents: number,
  capCents: number,
): string | null {
  if (amountCents <= 0) return null;
  // Strict `>`: an adjustment landing exactly ON the ceiling is allowed, so a
  // default cap equal to ADJUST_MAX_RM still admits one full-size grant.
  if (windowCents + amountCents <= capCents) return null;
  // Clamped at 0 — once the window is already over the ceiling (a lowered env,
  // or rows minted under a higher one) the remaining headroom must not read as
  // a negative amount the operator may still grant.
  const remaining = Math.max(0, capCents - windowCents) / 100;
  return (
    'Daily credit-adjustment limit reached (ADJUST_DAILY_MINT_MAX_RM): ' +
    `RM ${(windowCents / 100).toFixed(2)} already granted in the last 24h, ` +
    `RM ${remaining.toFixed(2)} remaining today.`
  );
}

export function adjustAmountError(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "Amount must be a number.";
  }
  if (value === 0) {
    return "Amount cannot be zero.";
  }
  if (Math.abs(value) > ADJUST_MAX_RM) {
    return `Amount must be at most RM ${ADJUST_MAX_RM.toLocaleString("en-US")} per adjustment.`;
  }
  // 2dp max with the same binary-representation epsilon as topUpAmountError:
  // an exact integer-cents comparison would reject valid money like 0.07
  // (0.07 * 100 is 7.000000000000001). NOT 10.1 — that one is exactly 1010.
  const cents = value * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) {
    return "Amount cannot be more precise than a cent.";
  }
  return null;
}

// The note is the audit trail (stored in CreditTransaction.reference) — an
// adjustment without a why is unreviewable, so it is required.
export function adjustNoteError(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    return "A note explaining the adjustment is required.";
  }
  if (value.length > ADJUST_NOTE_MAX) {
    return `Note is too long (max ${ADJUST_NOTE_MAX} chars).`;
  }
  return null;
}
