// Client-side pre-validation for the Levels tab — mirrors the server
// validateVipLevels invariants (modules/packs/vip-levels-validate.ts) so the
// operator sees problems inline before POSTing, surfaced directly on the
// Levels tab. Returns every problem (never stops at the first). `level` is
// index+1, not an input.
export const FRAME_LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

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
        errors.push(
          `Level ${level}: threshold must exceed level ${level - 1}'s.`,
        );
      prev = t;
    }
    // voucherInput / referralInput / boxTier are deliberately NOT checked here.
    // None of the three is editable on the tab any more (all three surfaces are
    // suspended), so a client error on one would be a block the operator has no
    // field to clear — the same reasoning #371 applied to referral and box tier.
    //
    // Voucher was the exception until the data it checked went away: the ladder
    // paid 12,000 at L90 and 15,000 at L100 against a 10,000 server cap, so two
    // rungs were flagged on every load and the tab grew a repair column just to
    // clear them. Vouchers are now 0 on every level (Migration20260805000000 —
    // the redeeming surface is suspended), nothing can breach the cap, and the
    // column is gone. All three stay enforced server-side, surfacing as a toast
    // rather than a permanent block.
    if (r.frameUnlock && !FRAME_LEVELS.includes(level))
      errors.push(
        `Level ${level}: a frame can only unlock on a decade level (10, 20, … 100).`,
      );
  });
  return errors;
}
