// Pure client-side validation + conversion for the referral tier editor
// (Referrals page). The backend re-validates (editReferralSettings), so this
// exists only to give the operator an inline message before the round trip.
// UI speaks RM and %, the wire speaks cents and basis points.

export interface TierRow {
  minRm: string;
  ratePct: string;
}

// Float-safe "is a whole number of hundredths": 1.15 * 100 is
// 114.99999999999999, so Number.isInteger(x * 100) rejects valid money
// (review 2026-08-25 finding 2). Round and compare within epsilon instead.
const isHundredths = (x: number): boolean =>
  Math.abs(x * 100 - Math.round(x * 100)) < 1e-6;

const num = (s: string): number | null => {
  const trimmed = s.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
};

/** Null = valid; otherwise the message to show inline. */
export function validateTierRows(rows: TierRow[]): string | null {
  if (rows.length === 0) return 'Add at least one tier.';
  let prevMin = -1;
  for (let i = 0; i < rows.length; i++) {
    const minRm = num(rows[i].minRm);
    const ratePct = num(rows[i].ratePct);
    if (minRm === null || ratePct === null) {
      return `Tier ${i + 1}: both fields must be numbers.`;
    }
    if (minRm < 0 || !isHundredths(minRm)) {
      return `Tier ${i + 1}: minimum must be a non-negative RM amount.`;
    }
    if (i === 0 && minRm !== 0) {
      return 'The first tier must start at RM 0.';
    }
    if (ratePct < 0 || ratePct > 100 || !isHundredths(ratePct)) {
      return `Tier ${i + 1}: rate must be 0–100% in steps of 0.01.`;
    }
    if (minRm <= prevMin) {
      return 'Tier minimums must be strictly increasing.';
    }
    prevMin = minRm;
  }
  return null;
}

/** Rows → wire payload. Call only after validateTierRows returned null. */
export function tierRowsToPayload(
  rows: TierRow[],
): { min_cents: number; rate_bp: number }[] {
  return rows.map((r) => ({
    min_cents: Math.round(Number(r.minRm) * 100),
    rate_bp: Math.round(Number(r.ratePct) * 100),
  }));
}
