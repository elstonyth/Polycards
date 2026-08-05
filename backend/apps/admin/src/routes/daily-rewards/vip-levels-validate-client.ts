// Client-side pre-validation for the Levels tab — mirrors the server
// validateVipLevels invariants (modules/packs/vip-levels-validate.ts) so the
// operator sees problems inline before POSTing, surfaced directly on the
// Levels tab. Returns every problem (never stops at the first). `level` is
// index+1, not an input.
export const FRAME_LEVELS = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

// COUPLED MIRROR of modules/packs/voucher-ranges.ts. Kept as a literal —
// separate builds, no shared package (same convention as
// lib/purchase-invoice-form.ts).
export const MAX_VOUCHER_MYR = 10_000;

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

// Shared by the validator below and by the tab, which renders a repair input
// for exactly the rows this flags. One rule, one place — a drift between them
// is how a row becomes unfixable.
export const voucherOutOfRange = (s: string): boolean => {
  const n = num(s);
  return !Number.isFinite(n) || n < 0 || n > MAX_VOUCHER_MYR;
};

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
    // Voucher IS checked, even though the column was removed — the shipped
    // ladder violates this bound today (L90=12000, L100=15000 vs a 10,000 cap
    // added in #247, whose comment sized it against seed-reward-economy-demo's
    // 0–888 range rather than this ladder). Staying silent would let canSave go
    // true and turn a visible block into a server toast naming a field the
    // admin no longer shows. The tab renders a repair input for these rows only.
    if (voucherOutOfRange(r.voucherInput))
      errors.push(
        `Level ${level}: voucher must be between 0 and ${MAX_VOUCHER_MYR.toLocaleString('en-US')} — lower it below, or have the cap raised if this rung is correct.`,
      );
    // referralInput / boxTier are deliberately NOT checked here. Neither is
    // editable on the tab any more, and neither bound is reachable from shipped
    // data (referral seeds are 1–5 against 0–100; a dangling box tier needs an
    // out-of-band DB change — there is no admin route that deletes a box). Both
    // stay enforced server-side, surfacing as a toast instead.
    if (r.frameUnlock && !FRAME_LEVELS.includes(level))
      errors.push(
        `Level ${level}: a frame can only unlock on a decade level (10, 20, … 100).`,
      );
  });
  return errors;
}
