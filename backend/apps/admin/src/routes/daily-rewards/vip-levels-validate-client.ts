// Client-side pre-validation for the Levels tab — mirrors the server
// validateVipLevels invariants (modules/packs/vip-levels-validate.ts) so the
// operator sees problems inline before POSTing, surfaced directly on the
// Levels tab. Returns every problem (never stops at the first). `level` is
// index+1, not an input.
export const FRAME_LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

// COUPLED MIRROR of modules/packs/voucher-ranges.ts. Kept as a literal —
// separate builds, no shared package (same convention as
// lib/purchase-invoice-form.ts).
const MAX_VOUCHER_MYR = 10_000;

export interface VipLevelRow {
  thresholdInput: string;
  voucherInput: string;
  boxTier: string;
  frameUnlock: boolean;
  referralInput: string;
}

// A blank field is NOT a valid 0 — Number('') coerces to 0, which would let an
// accidentally cleared money field silently save as zero.
const num = (s: string): number => (s.trim() === '' ? NaN : Number(s));

export function validateVipLevelsClient(rows: VipLevelRow[]): string[] {
  const errors: string[] = [];
  if (rows.length < 1) {
    errors.push('The ladder must have at least 1 level.');
    return errors;
  }
  let prev = -1;
  rows.forEach((r, i) => {
    const level = i + 1;
    const t = num(r.thresholdInput);
    if (!Number.isFinite(t) || t < 0) {
      errors.push(`Level ${level}: threshold must be a number ≥ 0.`);
    } else {
      if (level === 1 && t !== 0) errors.push('Level 1: threshold must be 0.');
      if (level > 1 && !(t > prev))
        errors.push(`Level ${level}: threshold must exceed level ${level - 1}'s.`);
      prev = t;
    }
    const v = num(r.voucherInput);
    if (!Number.isFinite(v) || v < 0 || v > MAX_VOUCHER_MYR)
      errors.push(
        `Level ${level}: voucher amount must be between 0 and ${MAX_VOUCHER_MYR.toLocaleString()}.`,
      );
    const p = num(r.referralInput);
    if (!Number.isFinite(p) || p < 0 || p > 100)
      errors.push(`Level ${level}: referral % must be between 0 and 100.`);
    if (!r.boxTier || r.boxTier.trim().length === 0)
      errors.push(`Level ${level}: a box tier is required.`);
    if (r.frameUnlock && !FRAME_LEVELS.includes(level))
      errors.push(
        `Level ${level}: a frame can only unlock on a decade level (10, 20, … 100).`,
      );
  });
  return errors;
}
