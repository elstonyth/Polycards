// Pure input rules for the New Purchase Invoice form. Split out of page.tsx so
// they run under the node-environment vitest config (src/**/*.test.ts) without
// dragging React and @medusajs/ui into the test process.

/** The single line item the form edits. Money and qty are held as STRINGS, not
 *  numbers: `Number('')` is 0, which the server then rejects as "must be a
 *  non-zero integer", and a controlled Number() round-trip fights an operator
 *  midway through typing "1.0". They are parsed once, at submit. */
export type DraftLine = {
  card_handle: string;
  card_name: string;
  /** MYR, prefilled from the picked item's FMV. */
  fmv_snapshot: string;
  qty: string;
  unit_cost: string;
};

// Mirrors api/admin/purchase-invoices/validate.ts. Kept as literals rather than
// imported: the admin app and the Medusa backend are separate builds with no
// shared package (same duplication the format.ts mirrors already carry).
const MAX_MONEY = 1_000_000;
const MAX_QTY = 1_000_000;

/**
 * COUPLED MIRROR of validate.ts's `money()`. The 2-decimal cap is the load-
 * bearing half: Task 2 measured that a sub-sen unit_cost turns
 * `1000@1.005 - 999@1.004` into RM 1.00 against a true RM 2.00, a 100% error in
 * the weighted-average cost. The server rejects it with a 400 either way — this
 * exists so the operator gets told which field and why, and so the form NEVER
 * silently rounds a money value the operator typed.
 *
 * Returns an error message, or null when the value is acceptable.
 */
export function moneyError(raw: string, label: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return `${label} is required.`;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return `${label} must be a number >= 0.`;
  if (n > MAX_MONEY) return `${label} is too large (max ${MAX_MONEY}).`;
  // Same 1e-6 binary-representation epsilon as the server: an exact
  // integer-sen test would reject legitimate money like 10.1.
  if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
    return `${label} may carry at most 2 decimals.`;
  }
  return null;
}

/** Mirrors validate.ts's qty rules: a non-zero integer inside the column's
 *  range. Sign is NOT checked here — the form owns that (a reversal's lines are
 *  prefilled negative and read-only), and the server enforces it per invoice. */
export function qtyError(raw: string, label: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return `${label} is required.`;
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n === 0) {
    return `${label} must be a non-zero whole number.`;
  }
  if (Math.abs(n) > MAX_QTY) return `${label} is too large (max ${MAX_QTY}).`;
  return null;
}

/** First problem across the whole draft, or null when it is submittable. One
 *  message rather than per-field state: the form is a handful of rows and a
 *  single toast is what every other admin editor here does. */
export function draftError(
  supplier: string,
  lines: DraftLine[],
): string | null {
  if (supplier.trim() === '') return 'Supplier is required.';
  if (lines.length === 0) return 'Add at least one line.';
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const at = `Line ${i + 1}`;
    const err =
      moneyError(l.fmv_snapshot, `${at} FMV`) ??
      qtyError(l.qty, `${at} qty`) ??
      moneyError(l.unit_cost, `${at} unit cost`);
    if (err) return err;
  }
  return null;
}

/**
 * A date-only value is the OPERATOR'S Asia/Kuala_Lumpur calendar day — the same
 * decision Epic 4 settled for the ledger's date filters, for the same reason:
 * this business runs on one MYT calendar. `new Date('2026-07-28').toISOString()`
 * would anchor to UTC midnight, which is 08:00 MYT the same morning and, read
 * back by a viewer at a negative UTC offset, renders as 27 July — an invoice
 * dated a day before the paper it was copied from.
 *
 * The `+08:00` literal is the decision, expressed in the value itself rather
 * than as offset arithmetic: MYT has never observed DST, which is what lets a
 * fixed offset stand in for a timezone library (same reasoning as the backend's
 * parseMytBound). The page authors the instant, so this is the boundary.
 *
 * `date` is an <input type="date"> value, i.e. always `YYYY-MM-DD`.
 */
export function mytMidnightIso(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toISOString();
}

/** Today in MYT as a `YYYY-MM-DD` <input type="date"> value — so an operator in
 *  Kuala Lumpur opening the form just after local midnight is offered today,
 *  not yesterday. Round-trips through mytMidnightIso for the same calendar day. */
export function mytToday(now: Date = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}
