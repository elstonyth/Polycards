import { describe, expect, test } from 'vitest';
import {
  validateVipLevelsClient,
  type VipLevelRow,
} from './vip-levels-validate-client';
import { decadesWithErrors } from './vip-ladder-shape';

const row = (over: Partial<VipLevelRow> = {}): VipLevelRow => ({
  thresholdInput: '0',
  voucherInput: '0',
  boxTier: 'a',
  frameUnlock: false,
  ...over,
});


describe('validateVipLevelsClient', () => {
  test('accepts a valid 2-rung ladder', () => {
    expect(
      validateVipLevelsClient([row(), row({ thresholdInput: '100' })]),
    ).toEqual([]);
  });

  test('flags an empty ladder', () => {
    expect(validateVipLevelsClient([])).toContain(
      'The ladder must have at least 1 level.',
    );
  });

  test('flags a non-zero first threshold', () => {
    expect(validateVipLevelsClient([row({ thresholdInput: '5' })])).toContain(
      'Level 1: threshold must be 0.',
    );
  });

  test('flags a non-increasing threshold', () => {
    const errs = validateVipLevelsClient([row(), row({ thresholdInput: '0' })]);
    expect(errs.some((e) => /Level 2: threshold must exceed/.test(e))).toBe(
      true,
    );
  });

  test('flags frame_unlock on a non-decade level', () => {
    expect(validateVipLevelsClient([row({ frameUnlock: true })])).toContain(
      'Level 1: a frame can only unlock on a decade level (10, 20, … 100).',
    );
  });

  // Box tier has no editor on the tab any more, and neither
  // bound is reachable from shipped data, so a client error on either would be
  // an uncorrectable block on saving the WHOLE ladder. Both stay enforced
  // server-side; this pins that the CLIENT stays quiet about them.
  test('does not block the ladder on box tier', () => {
    expect(
      validateVipLevelsClient([row({ boxTier: '' })]),
    ).toEqual([]);
    expect(
      validateVipLevelsClient([row({ boxTier: '   ' })]),
    ).toEqual([]);
  });

  // Voucher used to be the exception here, and it cost the tab a whole repair
  // column: the client checked a 10,000 cap that the shipped ladder broke
  // (L90 = 12,000, L100 = 15,000), so two rungs were flagged on every load and
  // the tab had to grow an input to clear them. Vouchers are now 0 on every
  // level (Migration20260805000000). With no editor and nothing left to breach
  // the bound, the client stays quiet; validateVipLevels still enforces it on
  // save, as a toast. Legacy amounts are still asserted below — a ladder loaded
  // before the migration must not re-block the tab.
  test('does not block the ladder on voucher amounts', () => {
    // The two real rungs that used to brick every save on this tab.
    expect(
      validateVipLevelsClient([row({ voucherInput: '12000' })]),
    ).toEqual([]);
    expect(
      validateVipLevelsClient([row({ voucherInput: '15000' })]),
    ).toEqual([]);
    // Values no editor can produce are equally not the client's problem —
    // they round-trip untouched and the server has the last word.
    expect(
      validateVipLevelsClient([row({ voucherInput: '-1' })]),
    ).toEqual([]);
    expect(validateVipLevelsClient([row({ voucherInput: '' })])).toEqual([]);
  });

  // Threshold is the one money-shaped field still edited here, so its
  // blank-is-not-zero guard has to survive the other three losing theirs.
  test('flags a blank threshold instead of coercing it to 0', () => {
    const errs = validateVipLevelsClient([row(), row({ thresholdInput: '' })]);
    expect(
      errs.some((e) => /Level 2: threshold must be a number/.test(e)),
    ).toBe(true);
  });

  // decadesWithErrors regexes `Level (\d+)` out of these strings to force the
  // owning decade open. An error whose message lost that prefix would leave the
  // offending row collapsed — a flagged ladder the operator cannot see to fix.
  test('errors carry a level prefix the decade opener can parse', () => {
    const ladder = Array.from({ length: 10 }, (_, i) =>
      row({ thresholdInput: i === 9 ? '' : String(i * 100) }),
    );
    const errs = validateVipLevelsClient(ladder);
    expect(errs).not.toEqual([]);
    expect(decadesWithErrors(errs)).toEqual(new Set([0]));
    // L90 and L100 land in decades 8 and 9 — the shape the real ladder uses.
    expect(
      decadesWithErrors([
        'Level 90: threshold must be a number ≥ 0.',
        'Level 100: threshold must be a number ≥ 0.',
      ]),
    ).toEqual(new Set([8, 9]));
  });
});
