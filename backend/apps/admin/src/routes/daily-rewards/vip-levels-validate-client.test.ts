import { describe, expect, test } from 'vitest';
import {
  validateVipLevelsClient,
  type VipLevelRow,
} from './vip-levels-validate-client';

const row = (over: Partial<VipLevelRow> = {}): VipLevelRow => ({
  thresholdInput: '0',
  voucherInput: '0',
  boxTier: 'a',
  frameUnlock: false,
  referralInput: '1',
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
    expect(errs.some((e) => /Level 2: threshold must exceed/.test(e))).toBe(true);
  });

  test('flags frame_unlock on a non-decade level', () => {
    expect(validateVipLevelsClient([row({ frameUnlock: true })])).toContain(
      'Level 1: a frame can only unlock on a decade level (10, 20, … 100).',
    );
  });

  // None of these three has an editor on the tab any more, so a client error on
  // one would be an uncorrectable block on saving the WHOLE ladder — there is
  // no field to go and fix. All three bounds are still enforced server-side
  // (vip-levels-validate.ts + the box_tier-exists lookup); this pins that the
  // CLIENT stays quiet about them.
  test('does not block the ladder on voucher, referral % or box tier', () => {
    expect(
      validateVipLevelsClient([
        row({ voucherInput: '999999', referralInput: '101', boxTier: '' }),
      ]),
    ).toEqual([]);
    expect(
      validateVipLevelsClient([
        row({ voucherInput: '-1', referralInput: '', boxTier: '   ' }),
      ]),
    ).toEqual([]);
  });

  // Threshold is the one money-shaped field still edited here, so its
  // blank-is-not-zero guard has to survive the other three losing theirs.
  test('flags a blank threshold instead of coercing it to 0', () => {
    const errs = validateVipLevelsClient([row(), row({ thresholdInput: '' })]);
    expect(errs.some((e) => /Level 2: threshold must be a number/.test(e))).toBe(true);
  });
});
