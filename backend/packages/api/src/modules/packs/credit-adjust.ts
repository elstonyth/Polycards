// Manual credit adjustment rules (operator grant / refund / clawback). Pure
// functions so the workflow step stays a thin orchestrator and the rules are
// unit-testable without a container. Mirrors topup.ts — same epsilon cent
// check, but signed amounts: positive grants, negative deducts.

// Per-call magnitude ceiling, same rationale as TOPUP_MAX_RM: generous for
// support work, small enough that a typo can't mint or claw an absurd amount.
export const ADJUST_MAX_RM = 10_000;

export const ADJUST_NOTE_MAX = 512;

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
